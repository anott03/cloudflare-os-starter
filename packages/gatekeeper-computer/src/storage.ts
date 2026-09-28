export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
const CHUNK_BYTES = 32 * 1024;
export const PACK_STAGING_TIMEOUT_MS = 300_000;

export function cancelPack(stream: ReadableStream<Uint8Array>): void {
  void stream.cancel().catch(() => {});
}

export function workspacePath(path: string): string {
  if (path.length > 1024 || !path.startsWith("/workspace/") ||
      path.split("/").some(part => part === ".." || part === ".") || path.includes("\0")) {
    throw new Error("Use an absolute path beneath /workspace without dot segments.");
  }
  return path;
}

export function commitId(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Expected a full Git commit ID.");
  return value;
}

export function boundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Expected an integer between 0 and ${maximum}.`);
  }
  return value;
}

export function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + CHUNK_BYTES));
      offset += Math.min(CHUNK_BYTES, bytes.byteLength - offset);
    },
  });
}

export class PackStore {
  #writers = new Map<string, AbortController>();

  constructor(private readonly storage: DurableObjectStorage) {}

  has(id: string): boolean {
    return this.storage.kv.get<number>(`${id}:count`) !== undefined;
  }

  async put(id: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    if (this.has(id) || this.#writers.has(id)) {
      cancelPack(stream);
      throw new Error("Pack already stored.");
    }
    this.delete(id);
    const reader = stream.getReader();
    const controller = new AbortController();
    this.#writers.set(id, controller);
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new Error("Git pack staging cancelled or timed out."));
        void reader.cancel().catch(() => {});
      }, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), PACK_STAGING_TIMEOUT_MS);
    let size = 0;
    let count = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), interrupted]);
        controller.signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_PACK_BYTES) throw new Error("Git pack exceeds 64 MiB.");
        for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK_BYTES) {
          controller.signal.throwIfAborted();
          this.storage.kv.put(`${id}:chunk:${count++}`, chunk.value.slice(offset, offset + CHUNK_BYTES));
          this.storage.kv.put(`${id}:progress`, count);
          await Promise.race([this.storage.sync(), interrupted]);
        }
      }
      controller.signal.throwIfAborted();
      this.storage.kv.put(`${id}:count`, count);
      this.storage.kv.delete(`${id}:progress`);
    } catch (error) {
      this.delete(id);
      throw error;
    } finally {
      clearTimeout(timer);
      this.#writers.delete(id);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  get(id: string): ReadableStream<Uint8Array> {
    const count = this.storage.kv.get<number>(`${id}:count`);
    if (count === undefined) throw new Error("Git pack is unavailable.");
    let index = 0;
    const storage = this.storage;
    return new ReadableStream({
      pull(controller) {
        if (index === count) return controller.close();
        const bytes = storage.kv.get<Uint8Array>(`${id}:chunk:${index++}`);
        if (bytes === undefined) throw new Error("Git pack is incomplete.");
        controller.enqueue(bytes);
      },
    });
  }

  delete(id: string): void {
    this.#writers.get(id)?.abort();
    for (;;) {
      const chunks = [...this.storage.kv.list<Uint8Array>({ prefix: `${id}:chunk:`, limit: 64 })];
      if (chunks.length === 0) break;
      for (const [key] of chunks) this.storage.kv.delete(key);
    }
    this.storage.kv.delete(`${id}:count`);
    this.storage.kv.delete(`${id}:progress`);
  }
}
