import { RpcTarget } from "cloudflare:workers";
import type { GitPullStatus, GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";

const HEADER_BYTES = 12;
const TRAILER_BYTES = 20;

class PackTransfer extends RpcTarget implements GitPullTransfer {
  #pack: ReadableStream<Uint8Array> | undefined;
  #status: GitPullStatus = { state: "streaming" };

  constructor(chunks: AsyncGenerator<Uint8Array, void, unknown>) {
    super();
    this.#pack = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const next = await chunks.next();
          if (next.done) {
            this.#settle({ state: "complete" });
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          this.#settle({ state: "failed", message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
      cancel: async () => {
        this.#settle({ state: "canceled" });
        await chunks.return(undefined);
      },
    }, { highWaterMark: 0 });
  }

  #settle(status: GitPullStatus): void {
    if (this.#status.state === "streaming") this.#status = status;
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    const pack = this.#pack;
    if (pack === undefined) throw new Error("git pull stream was already claimed");
    this.#pack = undefined;
    return pack;
  }

  async status(): Promise<GitPullStatus> {
    return this.#status;
  }

  [Symbol.dispose](): void {
    const pack = this.#pack;
    this.#pack = undefined;
    pack?.cancel().catch(() => {});
  }
}

async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function objectCount(stream: ReadableStream<Uint8Array>): Promise<number> {
  const header = new Uint8Array(HEADER_BYTES);
  let filled = 0;
  for await (const chunk of chunksOf(stream)) {
    const size = Math.min(HEADER_BYTES - filled, chunk.byteLength);
    header.set(chunk.subarray(0, size), filled);
    filled += size;
    if (filled === HEADER_BYTES) break;
  }
  const view = new DataView(header.buffer);
  if (filled < HEADER_BYTES || new TextDecoder().decode(header.subarray(0, 4)) !== "PACK" || view.getUint32(4) !== 2) {
    throw new Error("Stored Git pack is invalid.");
  }
  return view.getUint32(8);
}

async function* mergedPack(open: Array<() => ReadableStream<Uint8Array>>): AsyncGenerator<Uint8Array, void, unknown> {
  let total = 0;
  for (const pack of open) total += await objectCount(pack());
  const digest = new crypto.DigestStream("SHA-1");
  const writer = digest.getWriter();
  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, total);
  await writer.write(header);
  yield header;
  for (const pack of open) {
    let skip = HEADER_BYTES;
    let held = new Uint8Array(0);
    for await (const chunk of chunksOf(pack())) {
      const body = chunk.subarray(Math.min(skip, chunk.byteLength));
      skip -= chunk.byteLength - body.byteLength;
      if (body.byteLength === 0) continue;
      const joined = new Uint8Array(held.byteLength + body.byteLength);
      joined.set(held);
      joined.set(body, held.byteLength);
      const emit = joined.byteLength - TRAILER_BYTES;
      if (emit > 0) {
        const out = joined.slice(0, emit);
        await writer.write(out);
        yield out;
        held = joined.slice(emit);
      } else {
        held = joined;
      }
    }
    if (skip > 0 || held.byteLength !== TRAILER_BYTES) throw new Error("Stored Git pack is truncated.");
  }
  await writer.close();
  yield new Uint8Array(await digest.digest);
}

export function packTransfer(open: Array<() => ReadableStream<Uint8Array>>): GitPullTransfer {
  if (open.length === 0) throw new Error("git pull requested no objects");
  if (open.length === 1) return new PackTransfer(chunksOf(open[0]()));
  return new PackTransfer(mergedPack(open));
}
