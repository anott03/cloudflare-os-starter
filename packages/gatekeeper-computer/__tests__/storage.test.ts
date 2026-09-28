import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PackStore, byteStream, MAX_PACK_BYTES, PACK_STAGING_TIMEOUT_MS } from "../src/storage.js";

async function inStorage(test: (storage: DurableObjectStorage) => Promise<void>) {
  await runInDurableObject(env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId()), async (_instance, state) => test(state.storage));
}

function keys(storage: DurableObjectStorage) {
  return [...storage.kv.list({ prefix: "pack:" })].map(([key]) => key);
}

describe("PackStore in workerd", () => {
  it("records completion only after EOF and reads stored bytes", async () => {
    await inStorage(async storage => {
      const store = new PackStore(storage);
      await store.put("pack", byteStream(new Uint8Array([1, 2, 3])));
      expect(store.has("pack")).toBe(true);
      expect(new Uint8Array(await new Response(store.get("pack")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(storage.kv.get("pack:progress")).toBeUndefined();
      store.delete("pack");
      expect(keys(storage)).toEqual([]);
    });
  });

  it("deletes partial chunks after a source read fails", async () => {
    await inStorage(async storage => {
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (++reads === 1) controller.enqueue(new Uint8Array([42]));
          else controller.error(new Error("source failed"));
        },
      }, { highWaterMark: 0 });
      const store = new PackStore(storage);
      await expect(store.put("pack", stream)).rejects.toThrow("source failed");
      expect(store.has("pack")).toBe(false);
      expect(keys(storage)).toEqual([]);
    });
  });

  it("enforces the size cap and never waits for upstream cancellation", async () => {
    await inStorage(async storage => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(MAX_PACK_BYTES + 1)); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      });
      const store = new PackStore(storage);
      await expect(store.put("pack", stream)).rejects.toThrow("64 MiB");
      expect(cancelled).toBe(true);
      expect(keys(storage)).toEqual([]);
    });
  });

  it("aborts stalled reads without allowing a late writer to resurrect chunks", async () => {
    await inStorage(async storage => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      });
      const store = new PackStore(storage);
      const writing = store.put("pack", stream);
      const failed = expect(writing).rejects.toThrow("cancelled or timed out");
      store.delete("pack");
      await failed;
      expect(cancelled).toBe(true);
      expect(keys(storage)).toEqual([]);
      await store.put("pack", byteStream(new Uint8Array([99])));
      expect(store.has("pack")).toBe(true);
    });
  });

  it("bounds the entire transfer time, even when cancel never settles", async () => {
    await inStorage(async storage => {
      vi.useFakeTimers();
      try {
        const store = new PackStore(storage);
        const writing = store.put("pack", new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }));
        const failed = expect(writing).rejects.toThrow("cancelled or timed out");
        await vi.advanceTimersByTimeAsync(PACK_STAGING_TIMEOUT_MS);
        await failed;
        expect(keys(storage)).toEqual([]);
      } finally { vi.useRealTimers(); }
    });
  });

  it("cleans progress records and legacy chunks without a completion count after reconstruction", async () => {
    await inStorage(async storage => {
      storage.kv.put("pack:chunk:0", new Uint8Array([1]));
      storage.kv.put("pack:chunk:5", new Uint8Array([2]));
      storage.kv.put("pack:progress", 6);
      new PackStore(storage).delete("pack");
      expect(keys(storage)).toEqual([]);
      storage.kv.put("pack:chunk:123", new Uint8Array([3]));
      new PackStore(storage).delete("pack");
      expect(keys(storage)).toEqual([]);
    });
  });
});
