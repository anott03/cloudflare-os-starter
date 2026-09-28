import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { byteStream } from "../src/storage.js";
import type { Outcome, TestHooks } from "./worker.js";
import type { StagedCheckout } from "../src/types.js";

function value<T>(result: Outcome<T>): T {
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}
function hooks() { return env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId()); }
async function receiving(stub: DurableObjectStub<TestHooks>): Promise<StagedCheckout> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const staged = value(await stub.list()).find(item => item.state === "receiving");
    if (staged) return staged;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Upload never started.");
}

describe("checkout staging on a real Gatekeeper facet", () => {
  it("sweeps interrupted and legacy markers after a facet reset", async () => {
    const stub = hooks();
    const partial = await stub.seed("partial");
    const legacy = await stub.seed("legacy");
    await stub.reset();
    expect(await stub.apply(partial.id)).toEqual({ error: "Action is unavailable." });
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
    expect((await stub.status(partial.jobId, partial.sandboxId)).state).toBe("rejected");
    expect((await stub.status(legacy.jobId, legacy.sandboxId)).state).toBe("rejected");
    expect(await stub.apply(partial.id)).toEqual({ error: "Action is unavailable." });
  });

  it("recovers a real interrupted upload after aborting the facet", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    const uploading = stub.checkout(sandboxId, new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    }));
    const stage = await receiving(stub);
    await stub.reset();
    expect(await uploading).toHaveProperty("error");
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
    expect((await stub.status(stage.jobId, sandboxId)).state).toBe("rejected");
  });

  it("frees a slot and rejects the action when its source stream fails", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    let reads = 0;
    const failed = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new Uint8Array([1]));
        else controller.error(new Error("source failed"));
      },
    }, { highWaterMark: 0 });
    expect(await stub.checkout(sandboxId, failed)).toHaveProperty("error");
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
    expect((await stub.audit()).queued).toHaveLength(1);
    expect(value(await stub.checkout(sandboxId, byteStream(new Uint8Array([2])))).state).toBe("queued");
  });

  it("retains complete packs waiting for approval across resets", async () => {
    const stub = hooks();
    const complete = await stub.seed("complete");
    await stub.reset();
    expect(value(await stub.list())).toEqual([{
      jobId: complete.jobId, sandboxId: complete.sandboxId, commitId: "a".repeat(40),
      directory: "/workspace/source", state: "awaiting-approval",
    }]);
    expect(await stub.keys()).toContain(`input:${complete.id}:count`);
    expect((await stub.status(complete.jobId, complete.sandboxId)).state).toBe("pending");
  });

  it("audits reads, denies cross-connection cancellation, and honors revocation", async () => {
    const stub = hooks();
    const stage = await stub.seed("complete");
    expect(value(await stub.list("other"))).toEqual([]);
    expect(await stub.cancel(stage.jobId, "other")).toEqual({ error: "Staged checkout does not belong to this connection or is unavailable." });
    expect((await stub.audit()).observation?.title).toBe("List staged checkouts");
    await stub.deny(true, false);
    expect(await stub.list()).toEqual({ error: "Observation denied." });
    await stub.deny(false, false);
    await stub.revoke();
    expect(await stub.list()).toEqual({ error: "Computer connection is disabled or revoked." });
    expect(await stub.cancel(stage.jobId)).toEqual({ error: "Computer connection is disabled or revoked." });
    expect(await stub.apply(stage.id)).toEqual({ error: "Computer connection is disabled or revoked." });
  });

  it("queues cancellation for approval even when the sandbox was deleted", async () => {
    const stub = hooks();
    const stage = await stub.seed("complete", "deleted");
    await stub.deny(false, true);
    expect(await stub.cancel(stage.jobId)).toEqual({ error: "Action denied." });
    expect(value(await stub.list())).toHaveLength(1);
    await stub.deny(false, false);
    expect(value(await stub.cancel(stage.jobId)).state).toBe("queued");
    expect(value(await stub.list())).toHaveLength(1);
    const queued = (await stub.audit()).queued;
    expect(queued).toHaveLength(1);
    expect(queued[0].description.autoApprovable).toBeUndefined();
    expect(queued[0].description.actionKind).toBeUndefined();
    expect(queued[0].description.title).toBe("Computer: cancel in Seeded");
    expect(await stub.apply(queued[0].id)).toEqual({ ok: undefined });
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
    expect((await stub.status(stage.jobId, stage.sandboxId)).state).toBe("rejected");
    expect(await stub.apply(stage.id)).toEqual({ error: "Action is unavailable." });
  });

  it("holds exactly two connection slots and frees one only after cancellation is approved", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    const otherSandboxId = await stub.create();
    expect(value(await stub.checkout(sandboxId, byteStream(new Uint8Array([1])))).state).toBe("queued");
    expect(value(await stub.checkout(otherSandboxId, byteStream(new Uint8Array([2])))).state).toBe("queued");
    const stages = value(await stub.list());
    expect(stages).toHaveLength(2);
    expect(await stub.checkout(sandboxId, new ReadableStream({ cancel() { return new Promise<void>(() => {}); } })))
      .toEqual({ error: "Finish or reject existing checkouts before staging another." });
    value(await stub.cancel(stages[0].jobId));
    expect(value(await stub.list())).toHaveLength(2);
    const cancel = (await stub.audit()).queued.find(item => item.description.title.startsWith("Computer: cancel"));
    if (!cancel) throw new Error("Cancellation not queued.");
    value(await stub.apply(cancel.id));
    expect(value(await stub.checkout(sandboxId, byteStream(new Uint8Array([3])))).state).toBe("queued");
    expect(value(await stub.list())).toHaveLength(2);
  });

  it("rejects an incomplete live upload promptly and never submits it later", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    const uploading = stub.checkout(sandboxId, new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }));
    const stage = await receiving(stub);
    const action = await stub.status(stage.jobId, sandboxId);
    const [application, rejection] = await Promise.all([stub.apply(action.id), stub.reject(action.id)]);
    if (!("error" in application)) throw new Error("Incomplete checkout was applied.");
    expect(["Checkout staging is incomplete.", "Action is unavailable."]).toContain(application.error);
    if ("error" in rejection) {
      expect(rejection.error).toBe("Action is being applied; retry after it finishes.");
      value(await stub.reject(action.id));
    }
    expect(await uploading).toHaveProperty("error");
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
    expect((await stub.audit()).queued.map(item => item.id)).not.toContain(action.id);
    expect(await stub.apply(action.id)).toEqual({ error: "Action is unavailable." });
  });

  it("rejects a completed transfer if access was revoked while receiving it", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    let finish = () => {};
    const uploading = stub.checkout(sandboxId, new ReadableStream<Uint8Array>({
      start(controller) { finish = () => controller.close(); },
    }));
    const stage = await receiving(stub);
    await stub.revoke();
    finish();
    expect(await uploading).toEqual({ error: "Computer connection is disabled or revoked." });
    expect(await stub.keys()).toEqual([]);
    expect((await stub.status(stage.jobId, sandboxId)).state).toBe("rejected");
    expect((await stub.audit()).queued).toHaveLength(1);
  });

  it("cancels a stalled upload through approval without waiting on the source", async () => {
    const stub = hooks();
    const sandboxId = await stub.create();
    const uploading = stub.checkout(sandboxId, new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }));
    const stage = await receiving(stub);
    await stub.deleted(sandboxId);
    value(await stub.cancel(stage.jobId));
    const cancel = (await stub.audit()).queued.find(item => item.description.title.startsWith("Computer: cancel"));
    if (!cancel) throw new Error("Cancellation not queued.");
    value(await stub.apply(cancel.id));
    expect(await uploading).toHaveProperty("error");
    expect(value(await stub.list())).toEqual([]);
    expect(await stub.keys()).toEqual([]);
  });
});
