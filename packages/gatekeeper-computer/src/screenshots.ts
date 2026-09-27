import type { ScreenshotOptions } from "./types.js";
import { boundedInteger } from "./storage.js";

export type ScreenshotRequest = ScreenshotOptions & {
  viewport: { width: number; height: number };
  fullPage: boolean;
  timeoutMs: number;
};

export function screenshotRequest(options: ScreenshotOptions): ScreenshotRequest {
  if (options.url.length > 4096) throw new Error("Screenshot URL is too long.");
  const url = new URL(options.url);
  const port = Number(url.port);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || port < 1024 || port > 65535 || port === 8080) {
    throw new Error("Use a local HTTP app on an explicit port from 1024 to 65535, except 8080.");
  }
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  if (!boundedInteger(viewport.width, 2048) || !boundedInteger(viewport.height, 2048)) {
    throw new Error("Screenshot viewport dimensions must be positive.");
  }
  for (const selector of [options.selector, options.waitForSelector]) {
    if (selector !== undefined && (!selector.trim() || selector.length > 1024)) {
      throw new Error("Screenshot selectors must contain 1 to 1024 characters.");
    }
  }
  if (options.selector && options.fullPage) throw new Error("Choose selector or fullPage, not both.");
  const timeoutMs = boundedInteger(options.timeoutMs ?? 30000, 60000);
  if (!timeoutMs) throw new Error("Screenshot timeout must be positive.");
  return { ...options, url: url.href, viewport, fullPage: options.fullPage ?? false, timeoutMs };
}
