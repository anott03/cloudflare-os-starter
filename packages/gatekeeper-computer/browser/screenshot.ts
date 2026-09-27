import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({ options: {
  url: { type: "string" },
  file: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  timeout: { type: "string" },
  selector: { type: "string" },
  "wait-for-selector": { type: "string" },
  "full-page": { type: "boolean", default: false },
}, strict: true });

function integer(value: string | undefined, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error("Invalid capture limit.");
  return number;
}

function checkDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0 || width > 4096 || height > 8192 || width * height > 8 * 1024 * 1024) {
    throw new Error("Capture exceeds the image dimension limit.");
  }
}

async function capture(): Promise<void> {
  const url = new URL(values.url ?? "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || Number(url.port) < 1024 || Number(url.port) === 8080) {
    throw new Error("Only local app URLs are supported.");
  }
  if (!values.file || !/^\/workspace\/\.computer-screenshots\/[a-f0-9-]+\.png$/.test(values.file)) {
    throw new Error("Invalid screenshot output path.");
  }
  const timeout = integer(values.timeout, 60000);
  const viewport = { width: integer(values.width, 2048), height: integer(values.height, 2048) };
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: true, timeout });
  const deadline = setTimeout(() => { void browser.close().catch(() => {}); }, Math.max(1, timeout - (Date.now() - startedAt)));
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
    context.setDefaultTimeout(timeout);
    await context.route("**/*", async route => {
      const target = new URL(route.request().url());
      if (target.origin !== url.origin || target.username || target.password) {
        await route.abort("blockedbyclient");
        return;
      }
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout });
        if (response.status() >= 300 && response.status() < 400 && response.headers()["location"]) {
          await route.abort("blockedbyclient");
        } else {
          await route.fulfill({ response });
        }
      } catch {
        await route.abort("failed").catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", socket => {
      const target = new URL(socket.url());
      if (target.protocol === "ws:" && target.hostname === url.hostname && target.port === url.port &&
          !target.username && !target.password) socket.connectToServer();
      else socket.close();
    });
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "load", timeout });
    if (values["wait-for-selector"]) await page.locator(values["wait-for-selector"]).waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    let content: Buffer;
    if (values.selector) {
      const element = page.locator(values.selector);
      await element.waitFor({ state: "visible" });
      const bounds = await element.boundingBox();
      if (!bounds) throw new Error("Screenshot element has no visible bounds.");
      checkDimensions(bounds.width, bounds.height);
      content = await element.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "css", timeout });
    } else {
      if (values["full-page"]) {
        const bounds = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, innerWidth),
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, innerHeight),
        }));
        checkDimensions(bounds.width, bounds.height);
      }
      content = await page.screenshot({ type: "png", fullPage: values["full-page"], animations: "disabled", caret: "hide", scale: "css", timeout });
    }
    if (content.byteLength > 1024 * 1024) throw new Error("PNG exceeds 1 MiB. Capture a smaller viewport or an element.");
    checkDimensions(content.readUInt32BE(16), content.readUInt32BE(20));
    await writeFile(values.file, content, { flag: "wx" });
    console.log("Screenshot captured.");
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

await capture().catch(() => {
  console.error("Screenshot failed. Check that the local app and selectors are ready, and that the capture fits the size and time limits.");
  process.exitCode = 1;
});
