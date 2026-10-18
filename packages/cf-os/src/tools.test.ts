import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("a shown tool's stdout goes to stderr, leaving stdout to the command's results", () => {
  // In a child of its own, so this process's stdout is the one under test.
  const script = `
    import { defaultSpawn } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
    const result = defaultSpawn()(process.execPath, ["-e", "process.stdout.write('from the tool')"],
      { cwd: process.cwd(), capture: false });
    process.exitCode = result.status;
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "from the tool");
});
