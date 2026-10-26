import { base64url } from "jose";
import { z } from "zod";

// Sign in with ChatGPT is a public client: each login registers a new client under this ID, and the
// authorization callback returns the client ID issued for it. Only the loopback redirect is
// registered for it, so the browser lands on a page that does not load and the user pastes its URL
// back into the connect page.
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
const AGENT_NAME = "Cloudflare OS";
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

/** A live Sign in with ChatGPT grant. */
export type Grant = {
  access: string;
  refresh: string;
  /** When the access token stops being usable, in Unix milliseconds, less a safety margin. */
  expires: number;
  /** The client ID OpenAI issued this login, which refreshes must name. */
  clientId: string;
  email?: string;
};

/** What the authorization callback URL the user pasted carries. */
export type AuthorizationResult = { code: string; state: string; clientId: string };

/** The token endpoint rejected the grant itself, so only a new sign-in restores it. */
export class GrantRevokedError extends Error {}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

const TokenError = z.object({ error: z.string() });

const IdTokenClaims = z.object({ email: z.string().optional() });

function base64UrlRandom(bytes: number): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A fresh PKCE verifier and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlRandom(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url.encode(new Uint8Array(digest));
  return { verifier, challenge };
}

/** The URL that starts sign-in, for the installation `hostId` (a UUID). */
export function authorizeUrl(options: { state: string; challenge: string; hostId: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: AGENT_NAME,
    ext_agent_host_id: `urn:uuid:${options.hostId}`,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    nonce: base64UrlRandom(32),
  }).toString();
  return url.toString();
}

/** Reads the callback URL the user pasted, throwing a message fit to show them. */
export function parseCallbackUrl(input: string): AuthorizationResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste the full address from the page ChatGPT sign-in sent you to.");
  }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`The pasted address must start with ${REDIRECT_URI}.`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`ChatGPT sign-in failed: ${error}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code || !state || !clientId) {
    throw new Error("The pasted address is missing its code, state or client ID. Sign in again.");
  }
  return { code, state, clientId };
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = new TextDecoder().decode(base64url.decode(payload));
    return IdTokenClaims.parse(JSON.parse(json)).email;
  } catch {
    return undefined;
  }
}

async function requestToken(body: URLSearchParams): Promise<z.infer<typeof TokenResponse>> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = TokenError.parse(JSON.parse(text)).error;
    } catch {
      code = undefined;
    }
    if (code === "invalid_grant" || code === "invalid_client") {
      throw new GrantRevokedError(`OpenAI rejected the ChatGPT grant (${code}).`);
    }
    throw new Error(`OpenAI token request failed (${response.status}).`);
  }
  return TokenResponse.parse(JSON.parse(text));
}

function grantFrom(
  token: z.infer<typeof TokenResponse>, clientId: string, previous?: Grant,
): Grant {
  const scopes = token.scope?.split(/\s+/) ?? [];
  if (token.scope !== undefined && !scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(`The ChatGPT grant lacks ${DIRECT_TOKEN_SCOPE}.`);
  }
  const refresh = token.refresh_token ?? previous?.refresh;
  if (!refresh) throw new Error("OpenAI returned no refresh token.");
  const grant: Grant = {
    access: token.access_token,
    refresh,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
    clientId,
  };
  const email = emailFromIdToken(token.id_token) ?? previous?.email;
  if (email !== undefined) grant.email = email;
  return grant;
}

/** Exchanges the authorization code the callback carried for a grant. */
export async function exchangeCode(result: AuthorizationResult, verifier: string): Promise<Grant> {
  const token = await requestToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: result.clientId,
    code: result.code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  }));
  return grantFrom(token, result.clientId);
}

/** Redeems the grant's refresh token for a new access token. */
export async function refreshGrant(grant: Grant): Promise<Grant> {
  const token = await requestToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: grant.clientId,
    refresh_token: grant.refresh,
    resource: RESOURCE,
  }));
  return grantFrom(token, grant.clientId, grant);
}
