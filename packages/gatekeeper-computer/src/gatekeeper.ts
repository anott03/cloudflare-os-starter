import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ActionDescription, ActionField, ActionKind, AppUiContext, GatekeeperUiFrame, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, GitCache, GitPullHints,
  ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ComputerSession, FilePage, GitCheckout, Job, JobOutput, JobStatus, Sandbox, SandboxInfo, ScreenshotOptions, ScreenshotImage } from "./types.js";
import { screenshotRequest } from "./screenshots.js";
import type { Operation } from "./sandbox.js";
import { PackStore, boundedInteger, commitId, MAX_FILE_BYTES, workspacePath } from "./storage.js";
import TYPES from "./types.txt";
import MANAGER from "./generated/manager.txt";
import { ComputerManagement } from "./management.js";
export { ComputerAccountState } from "./account-state.js";

const ICON = { url: "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" d="M2 3h20v14H2zM8 21h8M12 17v4M6 7l3 3-3 3m6 0h5"/></svg>',
) };
const EXEC_ACTION = { tag: "computer.exec", label: "Run arbitrary sandbox commands" } satisfies ActionKind;
type AccountProps = { accountId: string };
type ActionRecord = {
  id: number;
  jobId: string;
  sandboxId: string;
  operation: Operation;
  state: "pending" | "applied" | "rejected";
};
type SandboxRecord = SandboxInfo & { creationJob: string };

@validateRpc()
export class ComputerGatekeeper extends DurableObject<Cloudflare.Env, AccountProps> implements Gatekeeper<ComputerSession> {
  #packs = new PackStore(this.ctx.storage);
  #applying = new Map<number, Promise<void>>();

  async checkAccess(): Promise<void> {
    await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(this.ctx.props.accountId)).assertActive();
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://github.com/cloudflare/computer",
      title: "Development sandboxes",
      snippet: "Build and test code in private Linux sandboxes. GitHub handles pushes and pull requests.",
      suggestedBindingName: "COMPUTER", tsType: "ComputerSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return [EXEC_ACTION]; }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<ComputerSession> {
    await this.checkAccess();
    return new ComputerSessionImpl(this, queue.dup());
  }

  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Development sandboxes cannot be shared with other users.");
  }
  async removeObserver(_id: string): Promise<void> {}

  sandbox(id: string): SandboxRecord {
    const record = this.ctx.storage.kv.get<SandboxRecord>(`sandbox:${id}`);
    if (!record) throw new Error("Sandbox does not belong to this connection.");
    return record;
  }

  @skipRpcValidation()
  sandboxStub(id: string) {
    this.sandbox(id);
    return this.env.SANDBOXES.get(this.env.SANDBOXES.idFromString(id));
  }

  async create(name: string, queue: RpcStub<ApprovalQueue>): Promise<Sandbox> {
    await this.checkAccess();
    if (!name.trim() || name.length > 100) throw new Error("Use a sandbox name of 1 to 100 characters.");
    for (const item of this.list()) {
      if (item.state !== "deleted") await this.info(item.id);
    }
    const count = this.list().filter(item => item.state !== "deleted" && item.state !== "failed").length;
    if (count >= this.env.MAX_SANDBOXES) throw new Error("Connection sandbox limit reached.");
    const id = this.env.SANDBOXES.newUniqueId().toString();
    const record: SandboxRecord = { id, name, state: "pending", creationJob: "" };
    this.ctx.storage.kv.put(`sandbox:${id}`, record);
    try {
      const action = await this.submit(id, { kind: "create" }, queue);
      record.creationJob = action.jobId;
      this.ctx.storage.kv.put(`sandbox:${id}`, record);
      return new SandboxImpl(this, id, queue.dup());
    } catch (error) {
      record.state = "failed";
      this.ctx.storage.kv.put(`sandbox:${id}`, record);
      throw error;
    }
  }

  list(): SandboxRecord[] {
    return [...this.ctx.storage.kv.list<SandboxRecord>({ prefix: "sandbox:" })].map(([, value]) => value);
  }

  async submit(sandboxId: string, operation: Operation, queue: RpcStub<ApprovalQueue>, source?: GitCheckout): Promise<ActionRecord> {
    await this.checkAccess();
    if (this.#creationApplied(sandboxId)) await this.info(sandboxId);
    const sandbox = this.sandbox(sandboxId);
    if (sandbox.state === "deleted" || sandbox.state === "failed" &&
        !["stop", "destroy"].includes(operation.kind)) throw new Error("Sandbox is unavailable.");
    const id = (this.ctx.storage.kv.get<number>("nextAction") ?? 0) + 1;
    this.ctx.storage.kv.put("nextAction", id);
    if (id > 1000) throw new Error("Connection action limit reached. Create a new connection.");
    const action: ActionRecord = {
      id, jobId: crypto.randomUUID(), sandboxId, operation, state: "pending",
    };
    this.ctx.storage.kv.put(`action:${id}`, action);
    this.ctx.storage.kv.put(`job:${action.jobId}`, id);
    try {
      if (source) {
        const pending = [...this.ctx.storage.kv.list<boolean>({ prefix: "pendingCheckout:", limit: 2 })];
        if (pending.length >= 2) {
          await source.pack.cancel();
          throw new Error("Finish or reject existing checkouts before staging another.");
        }
        this.ctx.storage.kv.put(`pendingCheckout:${id}`, true);
        await this.#packs.put(`input:${id}`, source.pack);
      }
      const details = this.#description(operation);
      const description: ActionDescription = {
        title: `Computer: ${operation.kind} in ${sandbox.name}`,
        description: details.description,
        implementsRevert: false, awaitDecision: true,
      };
      if (details.fields.length > 0) description.fields = details.fields;
      if (details.complete) description.descriptionIsComplete = true;
      if (operation.kind === "exec" || operation.kind === "screenshot") {
        description.actionKind = EXEC_ACTION;
        description.autoApprovable = true;
      }
      await queue.submitAction(id, description);
    } catch (error) {
      action.state = "rejected";
      this.ctx.storage.kv.put(`action:${id}`, action);
      this.#packs.delete(`input:${id}`);
      this.ctx.storage.kv.delete(`pendingCheckout:${id}`);
      throw error;
    }
    return action;
  }

  #description(operation: Operation): { description: string; fields: ActionField[]; complete: boolean } {
    switch (operation.kind) {
      case "create": return { description: "Start a billable Linux container with persistent workspace files.", fields: [], complete: true };
      case "exec": return {
        description: "Queue a shell command. It can change all sandbox files and use the configured network policy.",
        fields: [
          { label: "Command", kind: "text", value: operation.command },
          { label: "Working directory", kind: "inline", value: operation.cwd },
          { label: "Timeout", kind: "inline", value: `${operation.timeoutMs} ms` },
        ],
        complete: true,
      };
      case "screenshot": return {
        description: "Open a local app in a fresh Chromium session and capture a PNG. Page scripts run and may change local app data. Images remain private to this connection until read into the workspace.",
        fields: [
          { label: "URL", kind: "inline", value: operation.options.url },
          { label: "Viewport", kind: "inline", value: `${operation.options.viewport.width} × ${operation.options.viewport.height}` },
          { label: "Capture", kind: "inline", value: operation.options.selector ?? (operation.options.fullPage ? "Full page" : "Viewport") },
          { label: "Wait for", kind: "inline", value: operation.options.waitForSelector ?? "Page load" },
          { label: "Timeout", kind: "inline", value: `${operation.options.timeoutMs} ms` },
        ],
        complete: true,
      };
      case "write": return {
        description: "Replace a sandbox file.",
        fields: [
          { label: "Path", kind: "inline", value: operation.path },
          { label: "Content", kind: "text", value: operation.content },
        ],
        complete: true,
      };
      case "checkout": return {
        description: "Import a Git commit exported by the GitHub connection. No GitHub credentials are transferred.",
        fields: [
          { label: "Commit", kind: "inline", value: operation.commitId },
          { label: "Directory", kind: "inline", value: operation.directory },
        ],
        complete: false,
      };
      case "stop": return { description: "Cancel running and queued approved jobs and stop all sandbox processes. Only synchronized workspace files are retained.", fields: [], complete: true };
      case "destroy": return { description: "Cancel running and queued approved jobs, stop the sandbox, and permanently remove workspace files. Exported Git history is retained for pending pushes.", fields: [], complete: true };
      case "cancel": return {
        description: "Cancel a job. Cancelling a waiting job leaves the running job alone. Cancelling a running job stops sandbox processes; other queued jobs resume afterward. Earlier effects cannot be undone.",
        fields: [{ label: "Job", kind: "inline", value: operation.jobId }],
        complete: true,
      };
    }
  }

  action(jobId: string, sandboxId: string): ActionRecord {
    const id = this.ctx.storage.kv.get<number>(`job:${jobId}`);
    const action = id === undefined ? undefined : this.ctx.storage.kv.get<ActionRecord>(`action:${id}`);
    if (!action || action.sandboxId !== sandboxId) throw new Error("Job does not belong to this sandbox.");
    return action;
  }

  async applyAction(id: number): Promise<void> {
    const existing = this.#applying.get(id);
    if (existing) return existing;
    const applying = this.#apply(id);
    this.#applying.set(id, applying);
    try {
      await applying;
    } finally {
      this.#applying.delete(id);
    }
  }

  async #apply(id: number): Promise<void> {
    await this.checkAccess();
    const action = this.ctx.storage.kv.get<ActionRecord>(`action:${id}`);
    if (!action || action.state === "rejected") throw new Error("Action is unavailable.");
    if (action.state === "applied") return;
    if (["exec", "write", "checkout", "screenshot"].includes(action.operation.kind)) {
      const info = await this.info(action.sandboxId);
      if (info.state !== "ready" && info.state !== "stopped") throw new Error("Sandbox creation has not completed.");
    }
    const stub = this.sandboxStub(action.sandboxId);
    const account = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(this.ctx.props.accountId));
    if (action.operation.kind === "create") {
      await account.reserve(action.sandboxId, {
        name: this.sandbox(action.sandboxId).name, workspaceId: this.ctx.id.toString(), createdAt: Date.now(),
      });
    } else if (this.#creationApplied(action.sandboxId)) {
      await account.bindSandbox(action.sandboxId);
    }
    if (action.operation.kind === "cancel") {
      const target = this.action(action.operation.jobId, action.sandboxId);
      if (target.state === "pending") await this.rejectAction(target.id);
      else if (target.state === "applied") await stub.cancel(action.operation.jobId);
    } else {
      const pack = action.operation.kind === "checkout" ? this.#packs.get(`input:${id}`) : undefined;
      await stub.submit(action.jobId, action.operation, pack);
    }
    action.state = "applied";
    this.ctx.storage.kv.put(`action:${id}`, action);
    this.#packs.delete(`input:${id}`);
    this.ctx.storage.kv.delete(`pendingCheckout:${id}`);
  }

  #creationApplied(sandboxId: string): boolean {
    const creationJob = this.sandbox(sandboxId).creationJob;
    return creationJob !== "" && this.action(creationJob, sandboxId).state === "applied";
  }

  async rejectAction(id: number): Promise<void> {
    if (this.#applying.has(id)) throw new Error("Action is being applied; retry after it finishes.");
    const action = this.ctx.storage.kv.get<ActionRecord>(`action:${id}`);
    if (!action || action.state === "rejected") return;
    if (action.state === "applied") throw new Error("Applied work cannot be rejected.");
    action.state = "rejected";
    this.ctx.storage.kv.put(`action:${id}`, action);
    this.#packs.delete(`input:${id}`);
    this.ctx.storage.kv.delete(`pendingCheckout:${id}`);
    if (action.operation.kind === "create") {
      const sandbox = this.sandbox(action.sandboxId);
      sandbox.state = "failed";
      this.ctx.storage.kv.put(`sandbox:${sandbox.id}`, sandbox);
    }
  }

  async revertAction(_id: number): Promise<void> {
    throw new Error("Sandbox operations cannot be automatically reverted.");
  }

  async info(id: string): Promise<SandboxInfo> {
    const sandbox = this.sandbox(id);
    if (!sandbox.creationJob) return { id, name: sandbox.name, state: sandbox.state };
    const creation = this.action(sandbox.creationJob, id);
    if (creation.state !== "applied") return { id, name: sandbox.name, state: sandbox.state };
    const lifecycle = await this.sandboxStub(id).lifecycle();
    const status = await this.sandboxStub(id).status(creation.jobId);
    if (lifecycle === "deleted") sandbox.state = "deleted";
    else if (status.state === "failed" || status.state === "cancelled") sandbox.state = "failed";
    else if (status.state === "completed") sandbox.state = lifecycle;
    this.ctx.storage.kv.put(`sandbox:${id}`, sandbox);
    if (sandbox.state === "deleted") {
      await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(this.ctx.props.accountId)).release(id);
    }
    return { id, name: sandbox.name, state: sandbox.state };
  }

  async exportCommit(id: string, directory: string, ref: string, queue: RpcStub<ApprovalQueue>): Promise<string> {
    await this.checkAccess();
    await queue.authorizeObservation({ title: "Export sandbox Git commit", description: `Read Git history and file objects from ${directory} for OS. This does not push to GitHub.` });
    const count = this.ctx.storage.kv.get<number>("exportCount") ?? 0;
    if (count >= 16) throw new Error("Connection export limit reached.");
    this.ctx.storage.kv.put("exportCount", count + 1);
    const archive = `export:${crypto.randomUUID()}`;
    const result = await this.sandboxStub(id).exportCommit(directory, ref);
    await this.#packs.put(archive, result.pack);
    using cache = await queue.getGitCache();
    const objects = await cache.consumePack(this.#packs.get(archive));
    if (!objects.includes(result.commitId)) throw new Error("Export did not contain its head commit.");
    for (const oid of objects) this.ctx.storage.kv.put(`object:${oid}`, archive);
    return result.commitId;
  }

  async gitPull(oids: string[], cache: RpcStub<GitCache>, _hints: GitPullHints): Promise<void> {
    await this.checkAccess();
    const archives = new Set<string>();
    for (const oid of oids) {
      const archive = this.ctx.storage.kv.get<string>(`object:${commitId(oid)}`);
      if (!archive) throw new Error("Git object was not exported by this connection.");
      archives.add(archive);
    }
    for (const archive of archives) await cache.consumePack(this.#packs.get(archive));
  }
}

@validateRpc()
export class ComputerSessionImpl extends RpcTarget implements ComputerSession {
  #gatekeeper: ComputerGatekeeper;
  #queue: RpcStub<ApprovalQueue>;
  constructor(gatekeeper: ComputerGatekeeper, queue: RpcStub<ApprovalQueue>) {
    super(); this.#gatekeeper = gatekeeper; this.#queue = queue;
  }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
  async createSandbox(name: string): Promise<Sandbox> { return this.#gatekeeper.create(name, this.#queue); }
  async listSandboxes(): Promise<Array<{ id: string; name: string }>> {
    await this.#gatekeeper.checkAccess();
    await this.#queue.authorizeObservation({ title: "List development sandboxes", description: "Read sandbox names owned by this connection." });
    return this.#gatekeeper.list().map(({ id, name }) => ({ id, name }));
  }
  async openSandbox(id: string): Promise<Sandbox> {
    await this.#gatekeeper.checkAccess();
    this.#gatekeeper.sandbox(id);
    await this.#queue.authorizeObservation({ title: "Open development sandbox", description: "Open a sandbox owned by this connection." });
    return new SandboxImpl(this.#gatekeeper, id, this.#queue.dup());
  }
}

@validateRpc()
export class SandboxImpl extends RpcTarget implements Sandbox {
  #gatekeeper: ComputerGatekeeper;
  #id: string;
  #queue: RpcStub<ApprovalQueue>;
  constructor(gatekeeper: ComputerGatekeeper, id: string, queue: RpcStub<ApprovalQueue>) {
    super(); this.#gatekeeper = gatekeeper; this.#id = id; this.#queue = queue;
  }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
  async #observe(title: string): Promise<void> {
    await this.#gatekeeper.checkAccess();
    await this.#queue.authorizeObservation({ title, description: "Read data from this connection's private development sandbox." });
  }
  async info(): Promise<SandboxInfo> { await this.#observe("Read sandbox state"); return this.#gatekeeper.info(this.#id); }
  async #submit(operation: Operation, source?: GitCheckout): Promise<Job> {
    const action = await this.#gatekeeper.submit(this.#id, operation, this.#queue, source);
    return new JobImpl(this.#gatekeeper, this.#id, action.jobId, this.#queue.dup());
  }
  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<Job> {
    if (!command || command.length > 16384) throw new Error("Command must contain 1 to 16,384 characters.");
    const cwd = options?.cwd ?? "/workspace";
    if (cwd !== "/workspace") workspacePath(cwd);
    const timeoutMs = boundedInteger(options?.timeoutMs ?? 120000, 300000);
    if (timeoutMs === 0) throw new Error("Timeout must be positive.");
    return this.#submit({ kind: "exec", command, cwd, timeoutMs });
  }
  async screenshot(options: ScreenshotOptions): Promise<Job> {
    return this.#submit({ kind: "screenshot", options: screenshotRequest(options) });
  }
  async readScreenshot(jobId: string): Promise<ScreenshotImage> {
    await this.#observe("Read sandbox screenshot");
    const action = this.#gatekeeper.action(jobId, this.#id);
    if (action.operation.kind !== "screenshot" || action.state !== "applied") throw new Error("Screenshot is not available yet.");
    return this.#gatekeeper.sandboxStub(this.#id).readScreenshot(jobId);
  }
  async checkout(source: GitCheckout, directory: string): Promise<Job> {
    return this.#submit({ kind: "checkout", directory: workspacePath(directory), commitId: commitId(source.commitId) }, source);
  }
  async exportCommit(directory: string, ref = "HEAD"): Promise<string> {
    if (!ref || ref.length > 255) throw new Error("Invalid Git ref.");
    return this.#gatekeeper.exportCommit(this.#id, workspacePath(directory), ref, this.#queue);
  }
  async readFile(path: string, options?: { offsetBytes?: number; maxBytes?: number }): Promise<FilePage> {
    await this.#observe("Read sandbox file");
    return this.#gatekeeper.sandboxStub(this.#id).readFile(workspacePath(path), options?.offsetBytes ?? 0, options?.maxBytes ?? MAX_FILE_BYTES);
  }
  async writeFile(path: string, content: string): Promise<Job> {
    if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) throw new Error("File write exceeds 64 KiB.");
    return this.#submit({ kind: "write", path: workspacePath(path), content });
  }
  async getJob(id: string): Promise<Job> {
    await this.#observe("Open sandbox job");
    this.#gatekeeper.action(id, this.#id);
    return new JobImpl(this.#gatekeeper, this.#id, id, this.#queue.dup());
  }
  async stop(): Promise<Job> { return this.#submit({ kind: "stop" }); }
  async destroy(): Promise<Job> { return this.#submit({ kind: "destroy" }); }
}

@validateRpc()
export class JobImpl extends RpcTarget implements Job {
  #gatekeeper: ComputerGatekeeper;
  #sandbox: string;
  #id: string;
  #queue: RpcStub<ApprovalQueue>;
  constructor(gatekeeper: ComputerGatekeeper, sandbox: string, id: string, queue: RpcStub<ApprovalQueue>) {
    super(); this.#gatekeeper = gatekeeper; this.#sandbox = sandbox; this.#id = id; this.#queue = queue;
  }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
  async #observe(): Promise<void> {
    await this.#gatekeeper.checkAccess();
    await this.#queue.authorizeObservation({ title: "Read sandbox job", description: "Read execution state or captured command output." });
  }
  async status(): Promise<JobStatus> {
    await this.#observe();
    const action = this.#gatekeeper.action(this.#id, this.#sandbox);
    if (action.state !== "applied") return { id: this.#id, state: action.state === "rejected" ? "cancelled" : "queued", exitCode: null };
    if (action.operation.kind === "cancel") return { id: this.#id, state: "completed", exitCode: 0 };
    return this.#gatekeeper.sandboxStub(this.#sandbox).status(this.#id);
  }
  async output(cursor?: string): Promise<JobOutput> {
    await this.#observe();
    const action = this.#gatekeeper.action(this.#id, this.#sandbox);
    if (action.state !== "applied" || action.operation.kind === "cancel") return { stdout: "", stderr: "", nextCursor: null, truncated: false };
    return this.#gatekeeper.sandboxStub(this.#sandbox).output(this.#id, cursor);
  }
  async cancel(): Promise<void> {
    await this.#gatekeeper.submit(this.#sandbox, { kind: "cancel", jobId: this.#id }, this.#queue);
  }
}

@validateRpc()
export class ComputerAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Development sandboxes", avatar: ICON, singleton: { tsType: "ComputerSession" },
      providesUi: { title: "Sandboxes", icon: ICON },
    };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ComputerSession>>> {
    return this.ctx.exports.ComputerGatekeeper({ props: this.ctx.props });
  }
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const account = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(this.ctx.props.accountId));
    await account.assertActive();
    return { iframeHtml: MANAGER, ui: new RpcStub(new ComputerManagement(account)) };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new Error("Use the Computer connection's sandbox factory."); }
  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("No resource configurator."); }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(this.ctx.props.accountId)).revoke(); }
  async reconnect(): Promise<{ url: string }> { throw new Error("Create a new Computer connection."); }
  commitReconnect(_stageId: string): never { throw new Error("Computer connections have no credentials to reconnect."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.ComputerVerifier({}); }
}

export class ComputerVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void { throw new Error("Computer connections are private."); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Computer", url: "https://github.com/cloudflare/computer", logo: ICON,
      tagline: "Build and test code in private Linux sandboxes",
      description: "Experimental development environments. Uses the GitHub connector for source, pushes, and pull requests.",
      autoProvisionsAccount: true, providesAuth: false,
    };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!this.env.COMPUTER_ENABLED) throw new Error("Computer is disabled pending verification.");
    return this.ctx.exports.ComputerAccount({ props: { accountId: this.env.ACCOUNTS.newUniqueId().toString() } });
  }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Enable the optional Computer connector to create an account.");
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
}
