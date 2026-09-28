import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const script = fileURLToPath(new URL("../browser/screenshot.ts", import.meta.url));

function capture(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  return result.stderr;
}

it("reports URL validation errors without exposing a stack", () => {
  assert.equal(capture(["--url", "https://example.com"]), "Screenshot failed: Only local app URLs are supported.\n");
});

it("keeps screenshot output within the dedicated workspace directory", () => {
  assert.equal(capture(["--url", "http://localhost:3000", "--file", "/tmp/capture.png"]), "Screenshot failed: Invalid screenshot output path.\n");
});

it("bounds argument parser diagnostics from the real screenshot entrypoint", () => {
  const stderr = capture([`--${"x".repeat(5000)}`]);
  assert.match(stderr, /^Screenshot failed: Unknown option/);
  assert.equal(stderr.length, "Screenshot failed: ".length + 2048 + 1);
});
