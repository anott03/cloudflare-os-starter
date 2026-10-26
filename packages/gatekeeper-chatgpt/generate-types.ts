import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const temporary = new URL("./wrangler.types.generated.jsonc", import.meta.url);
const config = (await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"))
  .replace('"main": ".wrangler/validate/src/index.ts"', '"main": "src/index.ts"')
  .replace(/"build":\s*\{[^}]*\},/, "");
try {
  await writeFile(temporary, config);
  const result = spawnSync("pnpm", ["exec", "wrangler", "types", "--config", temporary.pathname, "--strict-vars", "false"], {
    cwd: new URL(".", import.meta.url), stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Worker type generation failed.");
} finally {
  await rm(temporary, { force: true });
}
