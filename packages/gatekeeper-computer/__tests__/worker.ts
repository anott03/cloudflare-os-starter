import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ActionDescription, ApprovalQueue, GitCache, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ComputerGatekeeper as ProductionGatekeeper } from "../src/gatekeeper.js";
import { PackStore, byteStream } from "../src/storage.js";
import type { ComputerSession, GitCheckout, Job, Sandbox, SandboxInfo } from "../src/types.js";

export { ComputerAccountState } from "../src/account-state.js";
export class UnusedSandbox extends DurableObject {}

export class ComputerGatekeeper extends ProductionGatekeeper {
  async seed(mode: "complete" | "partial" | "legacy", state: SandboxInfo["state"] = "pending") {
    const sandboxId = this.env.SANDBOXES.newUniqueId().toString();
    this.ctx.storage.kv.put(`sandbox:${sandboxId}`, { id: sandboxId, name: "Seeded", state, creationJob: "" });
    const id = (this.ctx.storage.kv.get<number>("nextAction") ?? 0) + 1;
    const jobId = crypto.randomUUID();
    this.ctx.storage.kv.put("nextAction", id);
    this.ctx.storage.kv.put(`action:${id}`, {
      id, jobId, sandboxId, state: "pending",
      operation: { kind: "checkout", commitId: "a".repeat(40), directory: "/workspace/source" },
    });
    this.ctx.storage.kv.put(`job:${jobId}`, id);
    this.ctx.storage.kv.put(`pendingCheckout:${id}`, true);
    if (mode === "complete") {
      await new PackStore(this.ctx.storage).put(`input:${id}`, byteStream(new Uint8Array([1, 2, 3])));
    } else {
      this.ctx.storage.kv.put(`input:${id}:chunk:0`, new Uint8Array([1]));
      if (mode === "partial") this.ctx.storage.kv.put(`input:${id}:progress`, 1);
    }
    return { id, jobId, sandboxId };
  }

  keys() {
    return [...this.ctx.storage.kv.list({ prefix: "input:" })].map(([key]) => key);
  }

  markDeleted(sandboxId: string) {
    const sandbox = this.sandbox(sandboxId);
    sandbox.state = "deleted";
    this.ctx.storage.kv.put(`sandbox:${sandboxId}`, sandbox);
  }
}

class UnusedGitCache extends RpcTarget implements GitCache {
  async get(): Promise<never> { throw new Error("Git cache not used."); }
  async has(): Promise<never> { throw new Error("Git cache not used."); }
  async stat(): Promise<never> { throw new Error("Git cache not used."); }
  async put(): Promise<never> { throw new Error("Git cache not used."); }
  async advertiseCommit(): Promise<never> { throw new Error("Git cache not used."); }
  async buildPack(): Promise<never> { throw new Error("Git cache not used."); }
  async consumePack(): Promise<never> { throw new Error("Git cache not used."); }
  async isAncestor(): Promise<never> { throw new Error("Git cache not used."); }
}

class TestQueue extends RpcTarget implements ApprovalQueue {
  constructor(private readonly storage: DurableObjectStorage) { super(); }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.storage.kv.put("observation", description);
    if (this.storage.kv.get<boolean>("denyObservation")) throw new Error("Observation denied.");
  }
  async submitAction(id: number, description: ActionDescription): Promise<void> {
    if (this.storage.kv.get<boolean>("denyAction")) throw new Error("Action denied.");
    this.storage.kv.put(`queued:${id}`, { id, description });
  }
  async getGitCache(): Promise<GitCache> { throw new Error("Git cache not used."); }
  async bindHook(): Promise<void> { throw new Error("Hooks not used."); }
}

export type Outcome<T> = { ok: T } | { error: string };
async function outcome<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  try { return { ok: await operation() }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

type TestSandbox = Disposable & {
  info: Sandbox["info"];
  checkout(source: GitCheckout, directory: string): Promise<Job & Disposable>;
};
type TestSession = Disposable & {
  createSandbox(name: string): Promise<TestSandbox>;
  openSandbox(id: string): Promise<TestSandbox>;
  listStagedCheckouts: ComputerSession["listStagedCheckouts"];
  cancelStagedCheckout(jobId: string): Promise<Job & Disposable>;
};
type TestFacet = {
  seed: ComputerGatekeeper["seed"];
  keys(): Promise<string[]>;
  markDeleted(id: string): Promise<void>;
  startSession(queue: ApprovalQueue): Promise<TestSession>;
  applyAction(id: number, cache: RpcStub<GitCache>): Promise<void>;
  rejectAction(id: number): Promise<void>;
  action(jobId: string, sandboxId: string): Promise<ReturnType<ComputerGatekeeper["action"]>>;
};

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #gatekeeper(name = "computer"): TestFacet {
    let accountId = this.ctx.storage.kv.get<string>("accountId");
    if (!accountId) {
      accountId = this.env.ACCOUNTS.newUniqueId().toString();
      this.ctx.storage.kv.put("accountId", accountId);
    }
    // SAFETY: this test worker exports the production subclass under ComputerGatekeeper.
    const exported = this.ctx.exports.ComputerGatekeeper as (options: { props: { accountId: string } }) => DurableObjectClass<ComputerGatekeeper>;
    return this.ctx.facets.get<ComputerGatekeeper>(name, () => ({ class: exported({ props: { accountId } }) }));
  }

  #queue() { return new TestQueue(this.ctx.storage); }

  async seed(mode: "complete" | "partial" | "legacy", state: SandboxInfo["state"] = "pending") {
    return this.#gatekeeper().seed(mode, state);
  }
  async keys() { return this.#gatekeeper().keys(); }
  async deleted(id: string) { await this.#gatekeeper().markDeleted(id); }
  async reset() { this.ctx.facets.abort("computer", new Error("Test invocation reset")); }
  async revoke() {
    const accountId = this.ctx.storage.kv.get<string>("accountId");
    if (!accountId) throw new Error("No account.");
    await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromString(accountId)).revoke();
  }
  async deny(observation: boolean, action: boolean) {
    this.ctx.storage.kv.put("denyObservation", observation);
    this.ctx.storage.kv.put("denyAction", action);
  }
  async audit() {
    return {
      observation: this.ctx.storage.kv.get<ObservationDescription>("observation"),
      queued: [...this.ctx.storage.kv.list<{ id: number; description: ActionDescription }>({ prefix: "queued:" })].map(([, value]) => value),
    };
  }
  async create() {
    const queue = this.#queue();
    using session = await this.#gatekeeper().startSession(queue);
    using sandbox = await session.createSandbox("Test");
    return (await sandbox.info()).id;
  }
  async checkout(sandboxId: string, pack: ReadableStream<Uint8Array>) {
    return outcome(async () => {
      const queue = this.#queue();
      using session = await this.#gatekeeper().startSession(queue);
      using sandbox = await session.openSandbox(sandboxId);
      const source: GitCheckout = { commitId: "a".repeat(40), pack };
      using job = await sandbox.checkout(source, "/workspace/source");
      return job.status();
    });
  }
  async list(name = "computer") {
    return outcome(async () => {
      const queue = this.#queue();
      using session = await this.#gatekeeper(name).startSession(queue);
      return session.listStagedCheckouts();
    });
  }
  async cancel(jobId: string, name = "computer") {
    return outcome(async () => {
      const queue = this.#queue();
      using session = await this.#gatekeeper(name).startSession(queue);
      using job = await session.cancelStagedCheckout(jobId);
      return job.status();
    });
  }
  async apply(id: number) {
    using cache = new RpcStub(new UnusedGitCache());
    return outcome(() => this.#gatekeeper().applyAction(id, cache));
  }
  async reject(id: number) { return outcome(() => this.#gatekeeper().rejectAction(id)); }
  async status(jobId: string, sandboxId: string) { return this.#gatekeeper().action(jobId, sandboxId); }
}

export default { fetch() { return new Response("Computer tests"); } };
