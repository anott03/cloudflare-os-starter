/** Sandboxes owned by this connection. IDs cannot open another connection's sandboxes. */
export interface ComputerSession {
  /** Reserve a sandbox. Check info() before using it. */
  createSandbox(name: string): Promise<Sandbox>;
  /** List the sandboxes created through this connection. */
  listSandboxes(): Promise<Array<{ id: string; name: string }>>;
  /** Reopen a sandbox from this connection after a session ends. */
  openSandbox(id: string): Promise<Sandbox>;
}

/** A shallow Git pack from GitHubRepo.exportCheckout(), containing no credentials. */
export interface GitCheckout {
  /** Full 40-character commit ID, used as the shallow history boundary. */
  commitId: string;
  /** Single-use Git pack stream. Maximum 64 MiB. */
  pack: ReadableStream<Uint8Array>;
}

/** An isolated Linux environment. Only files under /workspace are durable. */
export interface Sandbox {
  /** Return lifecycle state. A stopped sandbox restarts on the next command. */
  info(): Promise<SandboxInfo>;
  /**
   * Queue a shell command with a bounded execution timeout, excluding time spent waiting.
   * Requires approval unless the user has enabled command auto-approval for this connection.
   * Approved jobs run one at a time in approval order, with at most 16 waiting jobs per sandbox.
   * Later jobs still run after a failure. Check status before submitting dependent work.
   */
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<Job>;
  /**
   * Capture a local app using a fresh Chromium session and return a job to poll.
   * Start the app separately with exec(); capture only after it is ready. No server is started here.
   * Only http://localhost, http://127.0.0.1 and http://[::1] with an explicit port are supported.
   * Ports must be 1024–65535 except 8080. Browser requests stay on the selected origin.
   * Captures use the same serial queue as commands. Up to 32 images are retained until destroy().
   */
  screenshot(options: ScreenshotOptions): Promise<Job>;
  /**
   * Read a completed screenshot job as a PNG, at most 1 MiB and 8 megapixels.
   * In CFOS executeCode, pass this to the fourth argument's output.image() to show it in chat.
   */
  readScreenshot(jobId: string): Promise<ScreenshotImage>;
  /** Import into a new directory under /workspace. Submodules and LFS are not fetched. */
  checkout(source: GitCheckout, directory: string): Promise<Job>;
  /**
   * Export an existing local commit into OS for GitHubRepo.push(). Does not push to GitHub.
   * Complete jobs and stop the sandbox first. Commit ancestry must reach the imported base. Export is bounded to
   * 16 MiB of Git object content, 10,000 objects, and 1 MiB per object.
   */
  exportCommit(directory: string, ref?: string): Promise<string>;
  /** Read a bounded UTF-8 file segment. Offsets refer to bytes, not characters. */
  readFile(path: string, options?: { offsetBytes?: number; maxBytes?: number }): Promise<FilePage>;
  /** Write at most 64 KiB of UTF-8 text under /workspace. */
  writeFile(path: string, content: string): Promise<Job>;
  /** Reopen a job from this sandbox, including across sessions. */
  getJob(id: string): Promise<Job>;
  /** Cancel running and queued approved jobs and stop the container, retaining synchronized files. */
  stop(): Promise<Job>;
  /** Cancel running and queued approved jobs and delete workspace files. Exported Git objects remain in OS. */
  destroy(): Promise<Job>;
}

/** Capture options. A screenshot observes one page in a fresh, unauthenticated browser context. */
export interface ScreenshotOptions {
  /** Local app URL, including the port and optional path/query. */
  url: string;
  /** CSS pixels, 1–2048 per dimension. Defaults to 1280 × 800. */
  viewport?: { width: number; height: number };
  /** Capture the full document instead of the viewport. Cannot be combined with selector. */
  fullPage?: boolean;
  /** Optional selector identifying one element to capture. */
  selector?: string;
  /** Optional selector that must become visible before capture. */
  waitForSelector?: string;
  /** Total execution timeout, 1–60,000 ms, excluding queue time. Defaults to 30,000. */
  timeoutMs?: number;
}

/** Private PNG bytes returned by readScreenshot(). */
export interface ScreenshotImage {
  /** Filename for presentation or download. */
  name: string;
  /** The only supported capture format. */
  mimeType: "image/png";
  /** Encoded PNG bytes, not base64 or text. */
  content: Uint8Array;
}

/** Sandbox identity and lifecycle state. */
export interface SandboxInfo {
  id: string;
  name: string;
  state: "pending" | "ready" | "stopped" | "deleted" | "failed";
}

/** One submitted operation. Queued work may be waiting for approval or for an earlier approved job. */
export interface Job {
  /** Return lifecycle state and exit code. Interrupted jobs are never silently rerun. */
  status(): Promise<JobStatus>;
  /** Read captured output. At most 256 KiB is retained per job. */
  output(cursor?: string): Promise<JobOutput>;
  /**
   * Request cancellation. A waiting job is removed without stopping the running job.
   * Cancelling a running job stops sandbox processes; other queued jobs resume afterward.
   * Cancellation cannot undo effects already performed.
   */
  cancel(): Promise<void>;
}

/** Current job state. */
export interface JobStatus {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  exitCode: number | null;
  error?: string;
}

/** A page of UTF-8 file content. */
export interface FilePage {
  text: string;
  nextOffsetBytes: number | null;
}

/** A page of job output. Cursors are opaque and belong to this job. */
export interface JobOutput {
  stdout: string;
  stderr: string;
  nextCursor: string | null;
  truncated: boolean;
}
