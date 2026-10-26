import { escapeHtml, PAGE_STYLE } from "@gadgets/gatekeeper-kit/connect-pages";

/**
 * The page a connect or reconnect link opens: it sends the user to ChatGPT sign-in, then takes the
 * address of the page sign-in redirects to, which does not load, since only a loopback address is
 * registered for this client.
 */
export function connectPageHtml(options: { signInUrl: string; error?: string }): string {
  const error = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ChatGPT</title><style>${PAGE_STYLE}
  ol { padding-left: 20px; margin: 0 0 20px; }
  li { margin-bottom: 10px; }
  a.button, button { display: inline-block; font: inherit; font-size: 14px; padding: 8px 14px;
      border-radius: 8px; border: 0; background: var(--contrast); color: var(--on-contrast);
      text-decoration: none; cursor: pointer; }
  input { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px 10px;
      border: 1px solid var(--line); border-radius: 8px; background: var(--control);
      color: var(--text); margin: 6px 0 12px; }
</style></head>
<body><main><h1>Connect ChatGPT</h1>
<p class="sub">Models of the ChatGPT provider will run on your ChatGPT subscription.</p>
${error}
<ol>
<li><a class="button" href="${escapeHtml(options.signInUrl)}" target="_blank" rel="noopener noreferrer">Sign in with ChatGPT</a></li>
<li>Sign-in ends on a page at <code>127.0.0.1</code> that does not load. Copy that page's full address from the address bar.</li>
<li><form method="post">
<label for="callback">Paste it here:</label>
<input id="callback" name="callback" autocomplete="off" required
       placeholder="http://127.0.0.1:1455/auth/callback?code=…">
<button type="submit">Connect</button>
</form></li>
</ol></main></body></html>`;
}
