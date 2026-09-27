import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ManagedSandbox, ManagementAction, SandboxManagementPage, SandboxRegistration } from "./management-types.js";

@validateRpc()
export class ComputerAccountState extends DurableObject<Cloudflare.Env> {
  #assertActive(): void {
    if (!this.env.COMPUTER_ENABLED || this.ctx.storage.kv.get<boolean>("revoked")) {
      throw new Error("Computer connection is disabled or revoked.");
    }
  }

  async assertActive(): Promise<void> { this.#assertActive(); }

  #owns(id: string): void {
    if (!this.ctx.storage.kv.get<boolean>(`sandbox:${id}`)) throw new Error("Sandbox does not belong to this account.");
  }

  #stub(id: string) { return this.env.SANDBOXES.get(this.env.SANDBOXES.idFromString(id)); }

  async reserve(id: string, registration?: SandboxRegistration): Promise<void> {
    this.#assertActive();
    if (!this.ctx.storage.kv.get<boolean>(`sandbox:${id}`)) {
      const existing = [...this.ctx.storage.kv.list<boolean>({ prefix: "sandbox:", limit: this.env.MAX_SANDBOXES })];
      if (existing.length >= this.env.MAX_SANDBOXES) throw new Error("Account sandbox limit reached. Delete an unused sandbox in the Sandboxes manager.");
      this.ctx.storage.kv.put(`sandbox:${id}`, true);
    }
    if (registration && !this.ctx.storage.kv.get<SandboxRegistration>(`metadata:${id}`)) {
      this.ctx.storage.kv.put(`metadata:${id}`, registration);
    }
    await this.#stub(id).bindAccount(this.ctx.id.toString());
  }

  async bindSandbox(id: string): Promise<void> {
    this.#assertActive();
    this.#owns(id);
    await this.#stub(id).bindAccount(this.ctx.id.toString());
  }

  async release(id: string): Promise<void> {
    if (!this.ctx.storage.kv.get<boolean>(`sandbox:${id}`)) return;
    if (await this.#stub(id).lifecycle() !== "deleted") throw new Error("Sandbox files must be deleted before releasing its quota.");
    this.ctx.storage.kv.delete(`sandbox:${id}`);
    this.ctx.storage.kv.delete(`metadata:${id}`);
  }

  #history(): ManagementAction[] {
    return [...this.ctx.storage.kv.list<ManagementAction>({ prefix: "management:" })].map(([, action]) => action);
  }

  async listSandboxes(): Promise<SandboxManagementPage> {
    this.#assertActive();
    const ids = [...this.ctx.storage.kv.list<boolean>({ prefix: "sandbox:" })].map(([key]) => key.slice(8));
    const sandboxes: ManagedSandbox[] = [];
    for (const id of ids) {
      const metadata = this.ctx.storage.kv.get<SandboxRegistration>(`metadata:${id}`);
      const row: ManagedSandbox = { id, ...metadata, status: null };
      try {
        await this.bindSandbox(id);
        row.status = await this.#stub(id).managementStatus();
        if (row.status.state === "deleted") { await this.release(id); continue; }
      } catch {
        row.error = "Status unavailable. Refresh to retry; the quota reservation is retained.";
      }
      sandboxes.push(row);
    }
    return {
      sandboxes, reserved: [...this.ctx.storage.kv.list<boolean>({ prefix: "sandbox:" })].length,
      limit: this.env.MAX_SANDBOXES,
      history: this.#history().toSorted((a, b) => b.requestedAt - a.requestedAt),
    };
  }

  async requestManagementAction(id: string, kind: "stop" | "destroy"): Promise<ManagementAction> {
    this.#assertActive();
    this.#owns(id);
    const pending = this.#history().find(action => action.sandboxId === id && action.state === "pending");
    if (pending) {
      if (pending.kind !== kind) throw new Error("Another management operation is pending for this sandbox.");
      await this.ctx.storage.setAlarm(Date.now());
      return pending;
    }
    const history = this.#history().filter(action => action.state !== "pending").toSorted((a, b) => a.requestedAt - b.requestedAt);
    while (history.length >= 100) {
      const oldest = history.shift();
      if (oldest) this.ctx.storage.kv.delete(`management:${oldest.id}`);
    }
    const action: ManagementAction = { id: crypto.randomUUID(), sandboxId: id, kind, requestedAt: Date.now(), state: "pending" };
    this.ctx.storage.kv.put(`management:${action.id}`, action);
    await this.ctx.storage.setAlarm(Date.now());
    return action;
  }

  override async alarm(): Promise<void> {
    const pending = this.#history().filter(action => action.state === "pending");
    if (pending.length === 0) return;
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    for (const action of pending) {
      try {
        const stub = this.#stub(action.sandboxId);
        if (await stub.lifecycle() === "deleted") {
          await this.release(action.sandboxId);
          action.state = action.kind === "destroy" ? "completed" : "cancelled";
        } else {
          await this.bindSandbox(action.sandboxId);
          await stub.submit(action.id, { kind: action.kind });
          const status = await stub.status(action.id);
          if (status.state === "queued" || status.state === "running") continue;
          action.state = status.state;
          action.error = status.error;
          if (status.state === "completed" && action.kind === "destroy") await this.release(action.sandboxId);
        }
        action.completedAt = Date.now();
        this.ctx.storage.kv.put(`management:${action.id}`, action);
      } catch {
        if (this.ctx.storage.kv.get<boolean>("revoked")) {
          action.state = "cancelled";
          action.completedAt = Date.now();
          this.ctx.storage.kv.put(`management:${action.id}`, action);
        } else {
          action.error = "Operation is waiting or temporarily unavailable; retrying automatically.";
          this.ctx.storage.kv.put(`management:${action.id}`, action);
        }
      }
    }
  }

  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
    const ids = [...this.ctx.storage.kv.list<boolean>({ prefix: "sandbox:" })].map(([key]) => key.slice(8));
    for (const id of ids) await this.#stub(id).revoke();
  }
}
