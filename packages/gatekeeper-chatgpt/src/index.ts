import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ConnectHandoff, GatekeeperConnectCallback,
  GatekeeperConnectOptions, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorApi,
  ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ChatGptGatekeeperUser } from "@gadgets/workshop-shared/chatgpt-gatekeeper";
import {
  connectHandoffPageHtml, connectMutationError, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import {
  CONNECT_TIMEOUT_MS, constantTimeEqual, generateNonce, INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  authorizeUrl, createPkce, exchangeCode, type Grant, GrantRevokedError, parseCallbackUrl,
  refreshGrant,
} from "./oauth.js";
import { connectPageHtml } from "./pages.js";

const ICON = { url: "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0M12 8.5v7"/></svg>',
) };

/** One connect or reconnect attempt, from the link the Workshop opened to the pasted callback. */
type Attempt = {
  /** Nonce in the connect link; also the OAuth `state`, so the callback names this attempt. */
  nonce: string;
  verifier: string;
  expiresAt: number;
  reconnect: boolean;
};

type AccountProps = { accountId: string };

function baseUrl(env: Cloudflare.Env): string {
  return env.BASE_URL.replace(/\/+$/, "");
}

/**
 * One user's ChatGPT connection: the grant, its refresh, and the connect flow that obtains it.
 * Refreshes run one at a time, since a refresh token may be redeemable only once.
 */
export class ChatGptAccount extends DurableObject<Cloudflare.Env> {
  #refreshing: Promise<string | null> | undefined;

  #grant(): Grant | undefined {
    return this.ctx.storage.kv.get<Grant>("grant");
  }

  #callback(): Fetcher<GatekeeperConnectCallback> | undefined {
    return this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
  }

  async start(callback: Fetcher<GatekeeperConnectCallback>): Promise<string> {
    this.ctx.storage.kv.put("callback", callback);
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    return this.prepare(false);
  }

  prepare(reconnect: boolean): string {
    const nonce = generateNonce();
    this.ctx.storage.kv.delete("attempt");
    this.ctx.storage.kv.put<Omit<Attempt, "verifier">>("pendingNonce", { nonce, reconnect,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS });
    return nonce;
  }

  /**
   * The connect page's sign-in link. A fresh PKCE pair is minted on each visit, so a reload works;
   * the link nonce stays valid until it expires or a successful exchange consumes it.
   */
  async signInUrl(nonce: string): Promise<string | null> {
    const pending = this.ctx.storage.kv.get<Omit<Attempt, "verifier">>("pendingNonce");
    if (!pending || Date.now() >= pending.expiresAt || !constantTimeEqual(pending.nonce, nonce)) {
      return null;
    }
    const { verifier, challenge } = await createPkce();
    this.ctx.storage.kv.put<Attempt>("attempt", { ...pending, verifier });
    return authorizeUrl({ state: nonce, challenge, hostId: this.#hostId() });
  }

  #hostId(): string {
    let hostId = this.ctx.storage.kv.get<string>("hostId");
    if (!hostId) {
      hostId = crypto.randomUUID();
      this.ctx.storage.kv.put("hostId", hostId);
    }
    return hostId;
  }

  async acceptCallback(nonce: string, pasted: string): Promise<ConnectHandoff> {
    const attempt = this.ctx.storage.kv.get<Attempt>("attempt");
    if (!attempt || Date.now() >= attempt.expiresAt || !constantTimeEqual(attempt.nonce, nonce)) {
      throw new Error("This link has expired. Start the connection again.");
    }
    const result = parseCallbackUrl(pasted);
    if (!constantTimeEqual(result.state, attempt.nonce)) {
      throw new Error("The pasted address belongs to a different sign-in. Sign in again.");
    }
    const callback = this.#callback();
    if (!callback) throw new Error("This connection took too long. Start it again.");

    // The link stays usable until an exchange succeeds, so a failed one can be retried by signing
    // in again from the same page.
    const grant = await exchangeCode(result, attempt.verifier);
    this.ctx.storage.kv.delete("attempt");
    this.ctx.storage.kv.delete("pendingNonce");

    if (attempt.reconnect) {
      return callback.reconnectComplete(stageCredentials(this.ctx.storage.kv, grant, Date.now()));
    }
    if (this.ctx.storage.kv.get<boolean>("connectAttempted")) {
      throw new Error("This connection was already completed.");
    }
    this.ctx.storage.kv.put("grant", grant);
    this.ctx.storage.kv.put("connectAttempted", true);
    try {
      return await callback.complete(this.ctx.exports.ChatGptUser({
        props: { accountId: this.ctx.id.toString() },
      }));
    } catch (error) {
      this.ctx.storage.kv.delete("grant");
      throw error;
    }
  }

  commitReconnect(stageId: string): void {
    const grant = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.ctx.storage.kv.put("grant", grant);
    this.#refreshing = undefined;
  }

  email(): string | undefined {
    return this.#grant()?.email;
  }

  accessToken(): Promise<string | null> {
    const grant = this.#grant();
    if (!grant) return Promise.resolve(null);
    if (grant.expires > Date.now()) return Promise.resolve(grant.access);
    this.#refreshing ??= this.#refresh(grant).finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async #refresh(grant: Grant): Promise<string | null> {
    try {
      const refreshed = await refreshGrant(grant);
      // A reconnect or revoke landed while the refresh was in flight, and supersedes it.
      if (this.#grant()?.refresh !== grant.refresh) return this.#grant()?.access ?? null;
      this.ctx.storage.kv.put("grant", refreshed);
      return refreshed.access;
    } catch (error) {
      if (!(error instanceof GrantRevokedError)) throw error;
      this.#callback()?.credentialsExpired().catch(() => {});
      return null;
    }
  }

  async alarm(): Promise<void> {
    if (!this.#grant()) this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

/** The Workshop's handle on one user's ChatGPT connection. */
@validateRpc()
export class ChatGptUser extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements ChatGptGatekeeperUser {
  #account(): DurableObjectStub<ChatGptAccount> {
    const namespace = this.ctx.exports.ChatGptAccount;
    return namespace.get(namespace.idFromString(this.ctx.props.accountId));
  }

  async describe(): Promise<AccountDescription> {
    const description: AccountDescription = { displayName: "ChatGPT", avatar: ICON };
    const email = await this.#account().email();
    if (email !== undefined) description.uniqueName = email;
    return description;
  }

  async getUsableAccessToken(): Promise<string | null> {
    return this.#account().accessToken().catch(() => null);
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new Error("ChatGPT offers no resources."); }
  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("ChatGPT offers no resources.");
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  async revoke(): Promise<void> { await this.#account().revoke(); }

  async reconnect(): Promise<{ url: string }> {
    const nonce = await this.#account().prepare(true);
    return { url: `${baseUrl(this.env)}/${this.ctx.props.accountId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ChatGptVerifier({});
  }
}

export class ChatGptVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void { throw new Error("ChatGPT connections are private."); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperVendorApi {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "ChatGPT",
      url: "https://chatgpt.com",
      logo: ICON,
      tagline: "Run OpenAI models on your ChatGPT subscription",
      description: "Sign in with ChatGPT so that models of the ChatGPT provider count against your " +
        "ChatGPT plan's usage limits instead of an API key or AI Gateway credits.",
      providesAuth: false,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const namespace = this.ctx.exports.ChatGptAccount;
    const id = namespace.newUniqueId();
    const nonce = await namespace.get(id).start(callback);
    return { url: `${baseUrl(this.env)}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
}

function pageResponse(body: string, status = 200): Response {
  const response = htmlResponse(body, status);
  // The connect form posts back to this page; under no-referrer the browser would send
  // `Origin: null`, which the mutation check rejects.
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}

async function connectPage(stub: DurableObjectStub<ChatGptAccount>, nonce: string,
                           error?: string, status = 200): Promise<Response> {
  const signInUrl = await stub.signInUrl(nonce);
  if (!signInUrl) return htmlResponse(INVALID_LINK_HTML, 400);
  return pageResponse(connectPageHtml(error === undefined ? { signInUrl } : { signInUrl, error }),
    status);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    const base = new URL(baseUrl(env));
    if (!url.pathname.startsWith(base.pathname + "/")) {
      return new Response("Not found", { status: 404 });
    }
    const [accountId, nonce, ...rest] = url.pathname.slice(base.pathname.length + 1).split("/");
    if (rest.length > 0 || !/^[0-9a-f]{64}$/.test(accountId ?? "") ||
        nonce?.length !== NONCE_BYTES * 2) {
      return new Response("Not found", { status: 404 });
    }
    const namespace = ctx.exports.ChatGptAccount;
    let stub: DurableObjectStub<ChatGptAccount>;
    try {
      stub = namespace.get(namespace.idFromString(accountId));
    } catch {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }

    if (req.method === "GET") return connectPage(stub, nonce);
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const rejected = connectMutationError(req, {
      origin: base.origin, contentType: "application/x-www-form-urlencoded",
    });
    if (rejected) {
      return htmlResponse(errorPageHtml("Connection failed", "Start the connection again."),
        rejected === "cross-origin" ? 403 : 415);
    }
    const pasted = (await req.formData()).get("callback");
    if (typeof pasted !== "string") return connectPage(stub, nonce, "Paste the address.", 400);
    try {
      return htmlResponse(connectHandoffPageHtml(await stub.acceptCallback(nonce, pasted)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connecting ChatGPT failed.";
      return connectPage(stub, nonce, message, 400);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
