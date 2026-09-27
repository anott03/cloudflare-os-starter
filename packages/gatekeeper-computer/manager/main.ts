import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import { applyAccentColor, type GatekeeperAppTheme, type GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import type { ManagedSandbox, ManagementAction, SandboxManagementApi, SandboxManagementPage } from "../src/management-types.ts";

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<SandboxManagementApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
}

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void { applyTheme(theme); }
}

function applyTheme(theme: GatekeeperAppTheme): void {
  document.documentElement.dataset.mode = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  applyAccentColor(document.documentElement.style, theme.accentColor);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", onClick);
  return node;
}

function formatTime(value: number | undefined): string {
  return value === undefined ? "Unknown" : new Date(value).toLocaleString();
}

function stateLabel(sandbox: ManagedSandbox): string {
  if (!sandbox.status) return "Unavailable";
  if (sandbox.status.activeJob) return `Running ${sandbox.status.activeJob.kind}`;
  return sandbox.status.state === "ready" ? "Running" : "Stopped";
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing Sandboxes root.");
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const iframe = new AppIframe();
const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
host.subscribeTheme(iframe).then(applyTheme).catch(() => {});

let page: SandboxManagementPage | null = null;
let error: string | null = null;
let confirming: string | null = null;
let busy = new Set<string>();
let timer: number | undefined;

async function refresh(): Promise<void> {
  try {
    page = await host.ui.listSandboxes();
    error = null;
  } catch {
    error = "Could not load sandboxes. Refresh to try again.";
  }
  render();
  window.clearTimeout(timer);
  if (page?.history.some(action => action.state === "pending") ||
      page?.sandboxes.some(sandbox => sandbox.status?.activeJob || sandbox.status?.queuedJobs)) {
    timer = window.setTimeout(() => { void refresh(); }, 5000);
  }
}

async function request(id: string, kind: "stop" | "destroy"): Promise<void> {
  busy = new Set(busy).add(id);
  confirming = null;
  render();
  try {
    if (kind === "stop") await host.ui.stopSandbox(id);
    else await host.ui.deleteSandbox(id);
  } catch {
    error = kind === "stop" ? "Could not stop the sandbox." : "Could not delete the sandbox.";
  } finally {
    busy.delete(id);
    await refresh();
  }
}

function pendingFor(id: string): ManagementAction | undefined {
  return page?.history.find(action => action.sandboxId === id && action.state === "pending");
}

function renderSandbox(sandbox: ManagedSandbox): HTMLElement {
  const row = element("li", "row");
  const details = element("div", "details");
  details.append(element("h2", "name", sandbox.name ?? "Unnamed sandbox"));
  const meta = element("p", "meta");
  meta.append(element("span", "mono", sandbox.id.slice(0, 12)));
  meta.append(document.createTextNode(` · Created ${formatTime(sandbox.createdAt)}`));
  details.append(meta);
  details.append(element("p", "meta", sandbox.workspaceId ? `Workspace ${sandbox.workspaceId.slice(0, 12)}` : "Workspace unknown (created before workspace tracking)"));
  const status = element("p", "status");
  status.append(element("span", sandbox.status?.state === "ready" || sandbox.status?.activeJob ? "badge live" : "badge", stateLabel(sandbox)));
  if (sandbox.status?.queuedJobs) status.append(document.createTextNode(` · ${sandbox.status.queuedJobs} queued`));
  const pending = pendingFor(sandbox.id);
  if (pending) status.append(document.createTextNode(pending.kind === "destroy" ? " · Deleting" : " · Stopping"));
  if (sandbox.error) status.append(document.createTextNode(` · ${sandbox.error}`));
  details.append(status);
  row.append(details);

  const actions = element("div", "actions");
  const disabled = busy.has(sandbox.id) || pending !== undefined;
  if (confirming === sandbox.id) {
    actions.append(element("span", "warning", "Deletes files, screenshots and approved queued jobs."));
    actions.append(button("Cancel", "quiet", () => { confirming = null; render(); }));
    actions.append(button("Delete permanently", "danger", () => { void request(sandbox.id, "destroy"); }, disabled));
  } else {
    const idle = sandbox.status?.state === "stopped" && !sandbox.status.activeJob && !sandbox.status.queuedJobs;
    actions.append(button("Stop", "quiet", () => { void request(sandbox.id, "stop"); }, disabled || idle));
    actions.append(button("Delete", "quiet danger-text", () => { confirming = sandbox.id; render(); }, disabled));
  }
  row.append(actions);
  return row;
}

function render(): void {
  if (!root) return;
  root.replaceChildren();
  const header = element("header", "header");
  const intro = element("div", "intro");
  intro.append(element("h1", "", "Sandboxes"));
  intro.append(element("p", "subtle", "Every sandbox reserved by this Computer account, including those from deleted workspaces."));
  header.append(intro, button("Refresh", "quiet", () => { void refresh(); }));
  root.append(header);
  if (error) root.append(element("p", "error", error));
  if (!page) {
    root.append(element("p", "subtle", "Loading sandboxes…"));
    return;
  }
  root.append(element("p", "subtle", `${page.reserved} of ${page.limit} sandbox slots reserved. Stopped sandboxes keep their files and slot until deleted.`));
  if (page.sandboxes.length === 0) {
    root.append(element("p", "empty", "No sandboxes are reserved."));
  } else {
    const list = element("ul", "list");
    for (const sandbox of page.sandboxes) list.append(renderSandbox(sandbox));
    root.append(list);
  }
  if (page.history.length > 0) {
    root.append(element("h2", "section", "Recent operations"));
    const history = element("ul", "history");
    for (const action of page.history.slice(0, 20)) {
      const label = action.kind === "destroy" ? "Delete" : "Stop";
      const state = action.state === "pending" ? "In progress" : action.state[0].toUpperCase() + action.state.slice(1);
      const item = element("li", "", `${label} ${action.sandboxId.slice(0, 12)} · ${state} · ${formatTime(action.completedAt ?? action.requestedAt)}`);
      if (action.error && action.state !== "completed") item.append(document.createTextNode(` · ${action.error}`));
      history.append(item);
    }
    root.append(history);
  }
}

render();
void refresh();
