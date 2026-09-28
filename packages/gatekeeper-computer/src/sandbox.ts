import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Workspace, shellQuote, type DurableObjectStorageLike } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { FilePage, JobOutput, JobStatus, ScreenshotImage } from "./types.js";
import { inspectAgentPng, MAX_AGENT_IMAGE_BYTES } from "@gadgets/workshop-shared/png";
import type { ScreenshotRequest } from "./screenshots.js";
import type { ManagedSandboxStatus } from "./management-types.js";
import { exportGit } from "./git.js";
import { executeCommand, writeWorkspaceFile } from "./execution.js";
import { PackStore, boundedInteger, byteStream, commitId, MAX_FILE_BYTES, MAX_OUTPUT_BYTES, workspacePath } from "./storage.js";

export type Operation =
  | { kind: "create" }
  | { kind: "exec"; command: string; cwd: string; timeoutMs: number }
  | { kind: "write"; path: string; content: string }
  | { kind: "screenshot"; options: ScreenshotRequest }
  | { kind: "checkout"; directory: string; commitId: string }
  | { kind: "stop" }
  | { kind: "destroy" }
  | { kind: "cancel"; jobId: string };

type StoredJob = JobStatus & { operation: Operation; outputCount: number; outputBytes: number; truncated: boolean; staged?: boolean };
type OutputChunk = { channel: "stdout" | "stderr"; text: string };
const MAX_WAITING_JOBS = 16;

export class ComputerEgress extends WorkerEntrypoint<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
        !this.env.EGRESS_HOSTS.split(",").map(host => host.trim()).filter(Boolean).includes(url.hostname) || !["GET", "HEAD"].includes(request.method)) {
      return new Response("Sandbox egress denied", { status: 403 });
    }
    const headers = new Headers();
    headers.set("user-agent", "computer-development-sandbox");
    return fetch(url, { method: request.method, headers, redirect: "manual" });
  }
}

@validateRpc()
export class ComputerSandbox extends withWorkspaceContainer(class extends DurableObject<Cloudflare.Env> {}) {
  #workspace?: Workspace;
  #backend?: CloudflareContainerBackend;
  #exporting = false;
  #stopping = false;
  #running?: Promise<void>;
  #submissions = new Map<string, Promise<void>>();

  @skipRpcValidation()
  override getWorkspaceContainer() {
    return super.getWorkspaceContainer();
  }

  #ws(): Workspace {
    if (!this.#workspace) {
      this.#backend = new CloudflareContainerBackend({
        container: () => this,
        workspace: { binding: "SANDBOXES", id: this.ctx.id.toString() },
        egress: this.env.EGRESS_HOSTS.length === 0
          ? { mode: "none" }
          : { mode: "http-gateway", gateway: this.ctx.exports.ComputerEgress({}) },
      });
      // SAFETY: Computer only binds SQLite scalar values; its SQL row generic is wider than workerd's.
      const storage = this.ctx.storage as DurableObjectStorageLike;
      this.#workspace = new Workspace({ storage, backends: [this.#backend] });
    }
    return this.#workspace;
  }

  @skipRpcValidation()
  async __getWorkspaceStub() {
    return this.#ws().stub();
  }

  override async fetch(request: Request): Promise<Response> {
    this.#ws();
    if (!this.#backend) throw new Error("Computer backend unavailable.");
    return this.#backend.handleFetch(request);
  }

  #live(): void {
    if (!this.env.COMPUTER_ENABLED || this.ctx.storage.kv.get<boolean>("deleted") ||
        this.ctx.storage.kv.get<boolean>("revoked")) {
      throw new Error("Sandbox is unavailable.");
    }
  }

  async submit(id: string, operation: Operation, pack?: ReadableStream<Uint8Array>): Promise<void> {
    const existing = this.#submissions.get(id);
    if (existing) {
      await pack?.cancel();
      return existing;
    }
    const submission = this.#submit(id, operation, pack);
    this.#submissions.set(id, submission);
    try {
      await submission;
    } finally {
      this.#submissions.delete(id);
    }
  }

  #pending(): string[] {
    return this.ctx.storage.kv.get<string[]>("pendingJobs") ?? [];
  }

  async #schedule(): Promise<void> {
    if (this.#running || this.#stopping || this.#exporting) return;
    const active = this.ctx.storage.kv.get<string>("active");
    const first = this.#pending()[0];
    if (active || first) {
      const staging = !active && first !== undefined && this.#job(first).staged === false && this.#submissions.has(first);
      await this.ctx.storage.setAlarm(Date.now() + (staging ? 30000 : 0));
    } else if (!this.ctx.storage.kv.get<boolean>("deleted") && !this.ctx.storage.kv.get<boolean>("revoked")) {
      await this.ctx.storage.setAlarm(Date.now() + this.env.IDLE_TIMEOUT_MS);
    }
  }

  async #submit(id: string, operation: Operation, pack?: ReadableStream<Uint8Array>): Promise<void> {
    if (this.ctx.storage.kv.get<StoredJob>(`job:${id}`)) {
      await pack?.cancel();
      await this.#schedule();
      return;
    }
    this.#live();
    if (this.#exporting || this.#stopping) {
      await pack?.cancel();
      throw new Error("Sandbox is stopping or exporting. Retry approval after it finishes.");
    }
    const job: StoredJob = {
      id, state: "queued", exitCode: null, operation,
      outputCount: 0, outputBytes: 0, truncated: false, staged: operation.kind !== "checkout",
    };
    if (operation.kind === "stop" || operation.kind === "destroy") {
      await pack?.cancel();
      await this.#interrupt(true, job);
      return;
    }
    const pending = this.#pending();
    const active = this.ctx.storage.kv.get<string>("active");
    if ([...pending, ...(active ? [active] : [])].some(jobId => this.#job(jobId).operation.kind === "destroy")) {
      await pack?.cancel();
      throw new Error("Sandbox destruction has already been approved.");
    }
    if (pending.length >= MAX_WAITING_JOBS) {
      await pack?.cancel();
      throw new Error("Sandbox queue is full (16 waiting jobs). Wait for a job to finish or cancel a waiting job, then retry approval.");
    }
    if (operation.kind === "checkout" && !pack) throw new Error("Checkout pack is missing.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(`job:${id}`, job);
      this.ctx.storage.kv.put("pendingJobs", [...pending, id]);
    });
    await this.#schedule();
    if (operation.kind !== "checkout" || !pack) {
      await pack?.cancel();
      return;
    }
    try {
      await new PackStore(this.ctx.storage).put(`input:${id}`, pack);
      const current = this.#job(id);
      if (current.state === "cancelled") {
        new PackStore(this.ctx.storage).delete(`input:${id}`);
      } else {
        current.staged = true;
        this.ctx.storage.kv.put(`job:${id}`, current);
      }
    } catch {
      const current = this.#job(id);
      if (current.state !== "cancelled") {
        current.state = "failed";
        current.error = "Could not stage the checkout. Submit a new job.";
        this.ctx.storage.kv.put(`job:${id}`, current);
      }
      this.ctx.storage.kv.put("pendingJobs", this.#pending().filter(jobId => jobId !== id));
    }
    await this.#schedule();
  }

  async status(id: string): Promise<JobStatus> {
    const job = this.#job(id);
    return { id, state: job.state, exitCode: job.exitCode, error: job.error };
  }

  #job(id: string): StoredJob {
    const job = this.ctx.storage.kv.get<StoredJob>(`job:${id}`);
    if (!job) throw new Error("Job not found.");
    return job;
  }

  async output(id: string, cursor?: string): Promise<JobOutput> {
    const job = this.#job(id);
    let index = boundedInteger(cursor === undefined ? 0 : Number(cursor), job.outputCount);
    let stdout = "";
    let stderr = "";
    let size = 0;
    while (index < job.outputCount && size < MAX_FILE_BYTES) {
      const chunk = this.ctx.storage.kv.get<OutputChunk>(`output:${id}:${index++}`);
      if (!chunk) throw new Error("Job output is unavailable.");
      if (chunk.channel === "stdout") stdout += chunk.text;
      else stderr += chunk.text;
      size += new TextEncoder().encode(chunk.text).byteLength;
    }
    const finished = !["queued", "running"].includes(job.state);
    return { stdout, stderr, nextCursor: finished && index === job.outputCount ? null : String(index), truncated: job.truncated };
  }

  #append(job: StoredJob, channel: "stdout" | "stderr", text: string): void {
    if (this.#job(job.id).state === "cancelled") return;
    const bytes = new TextEncoder().encode(text);
    const remaining = MAX_OUTPUT_BYTES - job.outputBytes;
    const decoder = new TextDecoder();
    if (bytes.byteLength > remaining) job.truncated = true;
    for (let offset = 0; offset < Math.min(bytes.byteLength, remaining); offset += 8192) {
      const end = Math.min(offset + 8192, remaining, bytes.byteLength);
      this.ctx.storage.kv.put(`output:${job.id}:${job.outputCount++}`, {
        channel, text: decoder.decode(bytes.subarray(offset, end), { stream: end < Math.min(remaining, bytes.byteLength) }),
      });
      job.outputBytes += end - offset;
    }
    this.ctx.storage.kv.put(`job:${job.id}`, job);
  }

  override async alarm(): Promise<void> {
    if (this.#running) return this.#running;
    const hadWork = this.ctx.storage.kv.get<string>("active") !== undefined || this.#pending().length > 0;
    const running = this.#execute();
    this.#running = running;
    try {
      await running;
    } finally {
      this.#running = undefined;
    }
    if (hadWork || this.ctx.storage.kv.get<string>("active") || this.#pending().length > 0) await this.#schedule();
  }

  #finish(job: StoredJob): void {
    this.ctx.storage.transactionSync(() => {
      if (this.#job(job.id).state !== "cancelled") this.ctx.storage.kv.put(`job:${job.id}`, job);
      if (this.ctx.storage.kv.get<string>("active") === job.id) this.ctx.storage.kv.delete("active");
      new PackStore(this.ctx.storage).delete(`input:${job.id}`);
    });
  }

  async #execute(): Promise<void> {
    if (this.#stopping || this.#exporting) return;
    let id = this.ctx.storage.kv.get<string>("active");
    if (!id) {
      const pending = this.#pending();
      id = pending[0];
      if (!id) {
        await this.#stop();
        return;
      }
      if (this.#job(id).staged === false && this.#submissions.has(id)) return;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put("active", id);
        this.ctx.storage.kv.put("pendingJobs", pending.slice(1));
      });
    }
    const job = this.#job(id);
    if (job.state !== "queued") {
      if (job.state === "running" || job.state === "cancelled") await this.#stop();
      if (job.state === "running") {
        job.state = "failed";
        job.error = "Execution was interrupted; effects may have occurred. The job was not rerun.";
      }
      this.#finish(job);
      return;
    }
    if (job.staged === false) {
      job.state = "failed";
      job.error = "Checkout staging was interrupted. Submit a new job.";
      this.#finish(job);
      return;
    }
    job.state = "running";
    this.ctx.storage.kv.put(`job:${id}`, job);
    try {
      this.#live();
      await this.#run(job);
      job.state = job.exitCode === 0 ? "completed" : "failed";
    } catch (error) {
      if (job.operation.kind === "write") {
        const detail = error instanceof Error ? error.message.slice(0, 2048) : "Filesystem operation failed.";
        this.#append(job, "stderr", `File write failed: ${detail}\n`);
      }
      await this.#stop();
      job.state = "failed";
      job.error = "Operation failed. Inspect captured output; partial effects may remain.";
    }
    this.#finish(job);
  }

  async #run(job: StoredJob): Promise<void> {
    const operation = job.operation;
    if (operation.kind === "stop" || operation.kind === "destroy") {
      await this.#stop();
      if (operation.kind === "destroy") {
        await this.#ws().fs.rm("/workspace", { recursive: true, force: true });
        for (const id of this.ctx.storage.kv.get<string[]>("screenshots") ?? []) {
          new PackStore(this.ctx.storage).delete(`image:${id}`);
        }
        this.ctx.storage.kv.delete("screenshots");
        this.ctx.storage.kv.put("deleted", true);
      }
      job.exitCode = 0;
      return;
    }
    const ws = this.#ws();
    await ws.fs.mkdir("/workspace", { recursive: true });
    if (this.#job(job.id).state === "cancelled") return;
    if (operation.kind === "create") {
      await ws.ready();
      await this.getWorkspaceContainer().setInactivityTimeout(this.env.IDLE_TIMEOUT_MS);
      job.exitCode = 0;
    } else if (operation.kind === "write") {
      await writeWorkspaceFile(ws.fs, operation.path, operation.content);
      job.exitCode = 0;
    } else if (operation.kind === "exec") {
      await this.#command(job, operation.command, operation.cwd, operation.timeoutMs);
    } else if (operation.kind === "screenshot") {
      await this.#capture(job, operation.options);
    } else if (operation.kind === "checkout") {
      const dir = workspacePath(operation.directory);
      const base = commitId(operation.commitId);
      const input = `/workspace/.computer-import-${job.id}.pack`;
      await ws.fs.writeFile(input, new PackStore(this.ctx.storage).get(`input:${job.id}`));
      const q = shellQuote;
      const command = `set -eu; test ! -e ${q(dir)}; mkdir -p ${q(dir)}; ` +
        `git -c init.templateDir= init ${q(dir)}; cd ${q(dir)}; ` +
        `git index-pack --stdin < ${q(input)}; printf '%s\\n' ${q(base)} > .git/shallow; ` +
        `git -c core.hooksPath=/dev/null checkout --detach ${q(base)}; rm -- ${q(input)}`;
      await this.#command(job, command, "/workspace", this.env.MAX_COMMAND_MS);
      if (job.exitCode === 0) this.ctx.storage.kv.put(`base:${dir}`, base);
    } else {
      throw new Error("Unsupported operation.");
    }
  }

  async #capture(job: StoredJob, options: ScreenshotRequest): Promise<void> {
    const screenshots = this.ctx.storage.kv.get<string[]>("screenshots") ?? [];
    if (screenshots.length >= 32) {
      this.#append(job, "stderr", "Screenshot limit reached: at most 32 images per sandbox.\n");
      job.exitCode = 1;
      return;
    }
    const fs = this.#ws().fs;
    await fs.mkdir("/workspace/.computer-screenshots", { recursive: true });
    const file = `/workspace/.computer-screenshots/${job.id}.png`;
    const args = ["--url", options.url, "--file", file,
      "--width", String(options.viewport.width), "--height", String(options.viewport.height),
      "--timeout", String(options.timeoutMs)];
    if (options.selector) args.push("--selector", options.selector);
    if (options.waitForSelector) args.push("--wait-for-selector", options.waitForSelector);
    if (options.fullPage) args.push("--full-page");
    await this.#command(job, `node /opt/computer-browser/screenshot.mts ${args.map(shellQuote).join(" ")}`, "/workspace", options.timeoutMs);
    if (job.exitCode !== 0 || this.#job(job.id).state === "cancelled") return;
    const stream = await fs.readFile(file, { byteLength: MAX_AGENT_IMAGE_BYTES + 1 });
    const content = new Uint8Array(await new Response(stream).arrayBuffer());
    inspectAgentPng(content);
    const packs = new PackStore(this.ctx.storage);
    await packs.put(`image:${job.id}`, byteStream(content));
    if (this.#job(job.id).state === "cancelled") packs.delete(`image:${job.id}`);
    else this.ctx.storage.kv.put("screenshots", [...screenshots, job.id]);
  }

  async readScreenshot(id: string): Promise<ScreenshotImage> {
    this.#live();
    const job = this.#job(id);
    if (job.operation.kind !== "screenshot" || job.state !== "completed") throw new Error("Screenshot job has not completed successfully.");
    const content = new Uint8Array(await new Response(new PackStore(this.ctx.storage).get(`image:${id}`)).arrayBuffer());
    inspectAgentPng(content);
    return { name: `screenshot-${id}.png`, mimeType: "image/png", content };
  }

  async #command(job: StoredJob, command: string, cwd: string, timeoutMs: number): Promise<void> {
    if (this.#job(job.id).state === "cancelled") return;
    const ws = this.#ws();
    using run = await executeCommand(ws.runtime, command, {
      id: job.id, cwd, timeoutMs: Math.min(timeoutMs, this.env.MAX_COMMAND_MS),
    });
    if (this.#job(job.id).state === "cancelled") {
      await this.#stop();
      return;
    }
    await this.getWorkspaceContainer().setInactivityTimeout(this.env.IDLE_TIMEOUT_MS);
    try {
      for await (const event of run) {
        if (event.name === "exit") job.exitCode = event.code;
        else this.#append(job, event.name, event.value);
      }
      if (this.#job(job.id).state !== "cancelled") {
        for await (const _progress of ws.pull()) {}
      }
    } finally {
      if (this.#job(job.id).state !== "cancelled" && this.ctx.container?.running) {
        await ws.runtime.disposeExec(job.id);
      }
    }
  }

  async #stop(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.#workspace?.close();
    this.#workspace = undefined;
    this.#backend = undefined;
  }

  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
    await this.halt();
  }

  async halt(): Promise<void> {
    await this.#interrupt(true);
  }

  async #interrupt(cancelWaiting: boolean, next?: StoredJob): Promise<void> {
    if (this.#exporting || this.#stopping) throw new Error("Sandbox is stopping or exporting; retry after it finishes.");
    this.#stopping = true;
    try {
      const active = this.ctx.storage.kv.get<string>("active");
      const cancelled = cancelWaiting ? this.#pending() : [];
      if (active) cancelled.push(active);
      this.ctx.storage.transactionSync(() => {
        for (const id of cancelled) {
          const job = this.#job(id);
          if (job.state === "queued" || job.state === "running") {
            job.state = "cancelled";
            this.ctx.storage.kv.put(`job:${id}`, job);
          }
        }
        if (cancelWaiting) this.ctx.storage.kv.put("pendingJobs", []);
      });
      await this.#stop();
      await this.#running?.catch(() => {});
      await this.#stop();
      this.ctx.storage.kv.delete("active");
      for (const id of cancelled) new PackStore(this.ctx.storage).delete(`input:${id}`);
      if (next) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put(`job:${next.id}`, next);
          this.ctx.storage.kv.put("pendingJobs", [next.id]);
        });
      }
      if (this.#pending().length > 0) await this.ctx.storage.setAlarm(Date.now());
      else await this.ctx.storage.deleteAlarm();
    } finally {
      this.#stopping = false;
    }
    await this.#schedule();
  }

  async cancel(id: string): Promise<void> {
    const job = this.#job(id);
    if (!["queued", "running"].includes(job.state)) return;
    if (this.ctx.storage.kv.get<string>("active") === id) {
      await this.#interrupt(false);
    } else {
      this.ctx.storage.transactionSync(() => {
        job.state = "cancelled";
        this.ctx.storage.kv.put(`job:${id}`, job);
        this.ctx.storage.kv.put("pendingJobs", this.#pending().filter(jobId => jobId !== id));
        new PackStore(this.ctx.storage).delete(`input:${id}`);
      });
      await this.#schedule();
    }
  }

  async bindAccount(accountId: string): Promise<void> {
    const current = this.ctx.storage.kv.get<string>("accountId");
    if (current !== undefined && current !== accountId) throw new Error("Sandbox belongs to another account.");
    if (current === undefined) this.ctx.storage.kv.put("accountId", accountId);
  }

  async managementStatus(): Promise<ManagedSandboxStatus> {
    const activeId = this.ctx.storage.kv.get<string>("active");
    const active = activeId === undefined ? undefined : this.ctx.storage.kv.get<StoredJob>(`job:${activeId}`);
    return {
      state: await this.lifecycle(),
      activeJob: active ? { id: active.id, kind: active.operation.kind, state: active.state } : null,
      queuedJobs: this.#pending().length,
    };
  }

  async lifecycle(): Promise<"ready" | "stopped" | "deleted"> {
    if (this.ctx.storage.kv.get<boolean>("deleted")) return "deleted";
    return this.ctx.container?.running ? "ready" : "stopped";
  }

  async readFile(path: string, offsetBytes: number, maxBytes: number): Promise<FilePage> {
    this.#live();
    workspacePath(path);
    boundedInteger(offsetBytes, Number.MAX_SAFE_INTEGER);
    boundedInteger(maxBytes, MAX_FILE_BYTES);
    if (maxBytes === 0) throw new Error("Read size must be positive.");
    const fs = this.#ws().fs;
    const stat = await fs.stat(path);
    const text = await fs.readFile(path, { encoding: "utf8", byteOffset: offsetBytes, byteLength: maxBytes });
    return { text, nextOffsetBytes: offsetBytes + maxBytes < stat.size ? offsetBytes + maxBytes : null };
  }

  async exportCommit(directory: string, ref: string) {
    this.#live();
    if (this.#exporting || this.#stopping || this.#running || this.ctx.storage.kv.get<string>("active") || this.#pending().length > 0) {
      throw new Error("Finish or cancel all active and queued jobs before exporting.");
    }
    if (this.ctx.container?.running) throw new Error("Stop the sandbox before exporting its synchronized Git history.");
    const base = this.ctx.storage.kv.get<string>(`base:${workspacePath(directory)}`);
    if (!base) throw new Error("Directory was not imported through the GitHub bridge.");
    this.#exporting = true;
    try {
      const result = await exportGit(this.#ws(), directory, ref, base);
      return { commitId: result.commitId, pack: byteStream(result.bytes) };
    } finally {
      this.#exporting = false;
    }
  }
}
