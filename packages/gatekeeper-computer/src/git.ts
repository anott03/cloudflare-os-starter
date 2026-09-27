import * as git from "isomorphic-git";
import type { Workspace } from "@cloudflare/computer";
import { commitId, workspacePath } from "./storage.js";

export async function exportGit(workspace: Workspace, directory: string, ref: string, base: string) {
  const dir = workspacePath(directory);
  const fs = { promises: workspace.provider() };
  const head = commitId(await git.resolveRef({ fs, dir, ref }));
  const visited = new Set<string>();
  const stack = [{ oid: head, type: "commit" }];
  let totalBytes = 0;
  let reachedBase = false;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.oid)) continue;
    if (visited.size >= 10000) throw new Error("Export exceeds 10,000 Git objects.");
    const object = await git.readObject({ fs, dir, oid: entry.oid, format: "content" });
    if (object.format !== "content" || object.type !== entry.type) {
      throw new Error("Git object has an unexpected type.");
    }
    if (object.object.byteLength > 1024 * 1024) {
      throw new Error("OS cannot store Git objects larger than 1 MiB.");
    }
    totalBytes += object.object.byteLength;
    if (totalBytes > 16 * 1024 * 1024) throw new Error("Export exceeds 16 MiB of Git objects.");
    visited.add(entry.oid);
    if (object.type === "commit") {
      const { commit } = await git.readCommit({ fs, dir, oid: entry.oid });
      stack.push({ oid: commit.tree, type: "tree" });
      if (entry.oid === base) {
        reachedBase = true;
      } else {
        if (commit.parent.length === 0) throw new Error("Exported history does not reach the imported base.");
        for (const oid of commit.parent) stack.push({ oid, type: "commit" });
      }
    } else if (object.type === "tree") {
      const { tree } = await git.readTree({ fs, dir, oid: entry.oid });
      for (const child of tree) {
        if (child.mode === "160000") continue;
        stack.push({ oid: child.oid, type: child.type });
      }
    }
  }
  if (!reachedBase) throw new Error("Exported history does not include the imported base.");
  const result = await git.packObjects({ fs, dir, oids: [...visited], write: false });
  if (!result.packfile) throw new Error("Git did not produce a pack.");
  return { commitId: head, bytes: result.packfile };
}
