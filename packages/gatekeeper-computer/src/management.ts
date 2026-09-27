import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ComputerAccountState } from "./account-state.js";
import type { ManagementAction, SandboxManagementApi, SandboxManagementPage } from "./management-types.js";

function sandboxId(id: string): string {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid sandbox ID.");
  return id;
}

@validateRpc()
export class ComputerManagement extends RpcTarget implements SandboxManagementApi {
  #account: DurableObjectStub<ComputerAccountState>;

  constructor(account: DurableObjectStub<ComputerAccountState>) {
    super();
    this.#account = account;
  }

  async listSandboxes(): Promise<SandboxManagementPage> {
    return this.#account.listSandboxes();
  }

  async stopSandbox(id: string): Promise<ManagementAction> {
    return this.#account.requestManagementAction(sandboxId(id), "stop");
  }

  async deleteSandbox(id: string): Promise<ManagementAction> {
    return this.#account.requestManagementAction(sandboxId(id), "destroy");
  }
}
