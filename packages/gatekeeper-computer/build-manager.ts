import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["manager/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  write: false,
  logLevel: "warning",
});
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const styles = await readFile("manager/styles.css", "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandboxes</title><style>${styles}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>\n`;
await mkdir("src/generated", { recursive: true });
await writeFile("src/generated/manager.txt", html);
