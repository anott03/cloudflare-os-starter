import { env, runInDurableObject } from "cloudflare:test";
import { Workspace, type DurableObjectStorageLike, type ModuleExecutionInput, type WorkspaceModuleBackend, type WorkspaceRuntimeEvent } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/execution.js";
import { ComputerSandbox } from "../src/sandbox.js";

async function inSandbox(test: (sandbox: ComputerSandbox, state: DurableObjectState) => Promise<void>) {
  await runInDurableObject(env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId()), async (_instance, state) => {
    const sandbox = new ComputerSandbox(state, { ...env, EGRESS_HOSTS: "", IDLE_TIMEOUT_MS: 60_000 });
    try { await test(sandbox, state); }
    finally { await state.storage.deleteAlarm(); }
  });
}

describe("Computer runtime", () => {
  it("passes explicit process environment through the real Workspace runtime", async () => {
    await runInDurableObject(env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId()), async (_instance, state) => {
      const calls: ModuleExecutionInput[] = [];
      const backend = {
        protocol: "module",
        id: "recording",
        type: "test",
        async connect() {
          return {
            async exec(input: ModuleExecutionInput) {
              calls.push(input);
              const id = input.id ?? "execution";
              return { id, events: new ReadableStream<WorkspaceRuntimeEvent>({
                start(controller) {
                  controller.enqueue({ id, seq: 0, name: "stdout", value: new TextEncoder().encode("done") });
                  controller.enqueue({ id, seq: 1, name: "exit", code: 0 });
                  controller.close();
                },
              }) };
            },
            async getExec(): Promise<never> { throw new Error("No saved execution."); },
            async killExec() {},
            async disposeExec() {},
          };
        },
      } satisfies WorkspaceModuleBackend;
      // SAFETY: Computer binds SQLite scalar values, while its storage row generic is wider than workerd's.
      const storage = state.storage as DurableObjectStorageLike;
      const ws = new Workspace({ storage, backends: [backend] });
      try {
        for (const command of ["node app.mjs", "node /opt/computer-browser/screenshot.mts --url http://localhost:3000", "git index-pack --stdin"]) {
          using run = await executeCommand(ws.runtime, command, { id: crypto.randomUUID(), cwd: "/workspace", timeoutMs: 1234 });
          const result = await run.result();
          expect(result.stdout).toBe("done");
          expect(result.exitCode).toBe(0);
        }
        expect(calls).toHaveLength(3);
        for (const call of calls) {
          expect(call.env).toEqual({
            NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            PLAYWRIGHT_BROWSERS_PATH: "/opt/computer-browsers",
            GIT_TERMINAL_PROMPT: "0",
          });
          expect(call.cwd).toBe("/workspace");
          expect(call.timeoutMs).toBe(1234);
          expect(call.sync).toBe("wait");
        }
      } finally { await ws.close(); }
    });
  });

  it("creates missing parents and preserves UTF-8 contents for approved file writes", async () => {
    await inSandbox(async sandbox => {
      await sandbox.submit("nested", { kind: "write", path: "/workspace/app/src/index.html", content: "<h1>Hello 🌍</h1>" });
      await sandbox.alarm();
      expect((await sandbox.status("nested")).state).toBe("completed");
      expect(await sandbox.readFile("/workspace/app/src/index.html", 0, 1024)).toEqual({ text: "<h1>Hello 🌍</h1>", nextOffsetBytes: null });
      await sandbox.submit("overwrite", { kind: "write", path: "/workspace/app/src/index.html", content: "updated" });
      await sandbox.alarm();
      expect((await sandbox.status("overwrite")).state).toBe("completed");
      expect((await sandbox.readFile("/workspace/app/src/index.html", 0, 1024)).text).toBe("updated");
    });
  });

  it("captures useful filesystem failure details in private stderr", async () => {
    await inSandbox(async sandbox => {
      await sandbox.submit("file", { kind: "write", path: "/workspace/file", content: "not a directory" });
      await sandbox.alarm();
      await sandbox.submit("blocked", { kind: "write", path: "/workspace/file/child.txt", content: "cannot write" });
      await sandbox.alarm();
      expect((await sandbox.status("blocked")).state).toBe("failed");
      const output = await sandbox.output("blocked");
      expect(output.stdout).toBe("");
      expect(output.stderr).toMatch(/^File write failed: .+/);
      expect(output.stderr).toContain("path exists: /workspace/file");
      expect(output.stderr).not.toMatch(/\n\s+at /);
      expect(output.stderr.length).toBeLessThanOrEqual(2068);
    });
  });

  it("bounds filesystem error messages without retaining their stack", async () => {
    await inSandbox(async sandbox => {
      const parent = `/workspace/${"p".repeat(1007)}`;
      await sandbox.submit("long-parent", { kind: "write", path: parent, content: "not a directory" });
      await sandbox.alarm();
      expect((await sandbox.status("long-parent")).state).toBe("completed");
      await sandbox.submit("long-error", { kind: "write", path: `${parent}/child`, content: "blocked" });
      await sandbox.alarm();
      expect((await sandbox.status("long-error")).state).toBe("failed");
      const output = await sandbox.output("long-error");
      expect(output.stderr).toBe(`File write failed: ${`path exists: ${parent}: ${parent}`.slice(0, 2048)}\n`);
    });
  });

  it("rejects writes outside the workspace before creating their parents", async () => {
    await inSandbox(async sandbox => {
      for (const path of ["/tmp/app/file", "/workspace/../escaped/file", "/workspace/./file", "relative/file"]) {
        const id = crypto.randomUUID();
        await sandbox.submit(id, { kind: "write", path, content: "blocked" });
        await sandbox.alarm();
        expect((await sandbox.status(id)).state).toBe("failed");
        expect((await sandbox.output(id)).stderr).toContain("Use an absolute path beneath /workspace without dot segments.");
      }
    });
  });
});
