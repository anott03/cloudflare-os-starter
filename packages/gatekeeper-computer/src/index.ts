export { ComputerAccountState, ComputerGatekeeper, ComputerAccount, ComputerVerifier, GatekeeperVendor } from "./gatekeeper.js";
export { ComputerSandbox, ComputerEgress } from "./sandbox.js";
export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
