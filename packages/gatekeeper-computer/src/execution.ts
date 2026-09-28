import type { Workspace, WorkspaceRuntimeExecOptions } from "@cloudflare/computer";
import { workspacePath } from "./storage.js";

type CommandOptions = Pick<WorkspaceRuntimeExecOptions<"utf8">, "id" | "cwd" | "timeoutMs">;

export function executeCommand(runtime: Pick<Workspace["runtime"], "exec">, command: string, options: CommandOptions) {
  return runtime.exec(command, {
    ...options,
    encoding: "utf8",
    sync: "wait",
    env: {
      NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/computer-browsers",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

export async function writeWorkspaceFile(fs: Pick<Workspace["fs"], "mkdir" | "writeFile">, path: string, content: string): Promise<void> {
  const target = workspacePath(path);
  await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(target, content);
}
