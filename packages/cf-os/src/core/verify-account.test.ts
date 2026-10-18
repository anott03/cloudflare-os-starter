import assert from "node:assert/strict";
import test from "node:test";
import { CfAuthError, CfUnavailableError, type CloudflareClient } from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";
import { verifyAccount } from "./verify-account.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const config = {
  accountId: ACCOUNT,
  publicBaseUrl: null,
  workers: { router: { name: "acme-os", route: { customDomain: "os.example.com" } } },
  access: { issuer: "https://acme.cloudflareaccess.com", audience: "aud-1", admins: ["a@example.com"] },
  aiGateway: { enabled: true, name: "acme-ai", accountId: null, providers: ["cloudflare"] },
  context: { sharingDomain: null, kvNamespaceId: "kv-context" },
  resources: { blueprintsKvNamespaceId: "kv-blueprints", avatarsKvNamespaceId: null, blueprintContentBucket: "acme-content" },
} as unknown as DeploymentConfig;

const origin = "https://os.example.com";

/** An account that matches {@link config} in every respect; tests break one thing at a time. */
function matchingAccount(): MemoryAccount {
  return {
    organization: { auth_domain: "acme.cloudflareaccess.com" },
    accessApps: [{ name: "Cloudflare OS acme-os", aud: "aud-1", domain: "os.example.com" }],
    kvNamespaces: [{ id: "kv-context", title: "c" }, { id: "kv-blueprints", title: "b" }],
    buckets: ["acme-content"],
    gateways: [{ id: "acme-ai" }],
  };
}

async function problems(account: MemoryAccount, deployment = config): Promise<string[]> {
  const result = await verifyAccount(memoryClient(account), deployment, origin);
  assert.ok("problems" in result, `skipped: ${"skipped" in result ? result.skipped : ""}`);
  return result.problems;
}

test("passes an account that has everything the config names", async () => {
  assert.deepEqual(await problems(matchingAccount()), []);
});

test("rejects an audience no application in the account has, and names cf-os access", async () => {
  const found = await problems({ ...matchingAccount(), accessApps: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /no Access application .* has AUD tag aud-1/);
  assert.match(found[0], /pnpm cf-os access/);
});

test("rejects an application that does not cover the router's hostname", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Elsewhere", aud: "aud-1", domain: "other.example.com" }],
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /"Elsewhere" does not gate every path of os\.example\.com.*names other\.example\.com/);
});

test("rejects an application that gates only a path, or does not gate at all", async () => {
  for (const app of [
    { name: "Admin only", aud: "aud-1", domain: "os.example.com/admin" },
    { name: "Bookmark", aud: "aud-1", type: "bookmark", domain: "os.example.com" },
  ]) {
    const found = await problems({ ...matchingAccount(), accessApps: [app] });
    assert.equal(found.length, 1, app.name);
    assert.match(found[0], new RegExp(`"${app.name}" does not gate every path of os\\.example\\.com`));
  }
  // The whole origin, spelled with a path.
  assert.deepEqual(await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Everything", aud: "aud-1", domain: "os.example.com/*" }],
  }), []);
});

test("rejects a wildcard audience when a more specific application is the one Access applies", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [
      { name: "Wildcard", aud: "aud-1", domain: "*.example.com" },
      { name: "Specific", aud: "aud-2", domain: "os.example.com" },
    ],
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /"Specific" \(AUD aud-2\) names os\.example\.com more specifically than "Wildcard"/);
  assert.deepEqual(await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Wildcard", aud: "aud-1", domain: "*.example.com" }],
  }), []);
});

test("rejects an issuer from another team", async () => {
  const found = await problems({ ...matchingAccount(), organization: { auth_domain: "other.cloudflareaccess.com" } });
  assert.equal(found.length, 1);
  assert.match(found[0], /team domain is https:\/\/other\.cloudflareaccess\.com/);
});

test("rejects storage IDs and names the account does not have", async () => {
  const found = await problems({
    ...matchingAccount(),
    kvNamespaces: [{ id: "kv-context", title: "c" }],
    buckets: [],
    gateways: [{ id: "default" }],
  });
  assert.deepEqual(found.map((problem) => problem.split(":")[0]), [
    "resources.blueprintsKvNamespaceId",
    "resources.blueprintContentBucket",
    "aiGateway.name",
  ]);
});

test("asks nothing about storage left to automatic provisioning, or the default gateway", async () => {
  const client = memoryClient(matchingAccount());
  const provisioned = {
    ...config,
    aiGateway: { ...config.aiGateway, name: "default" },
    context: { sharingDomain: null, kvNamespaceId: null },
    resources: { blueprintsKvNamespaceId: null, avatarsKvNamespaceId: null, blueprintContentBucket: null },
  } as DeploymentConfig;
  assert.deepEqual(await verifyAccount(client, provisioned, origin), { problems: [] });
  assert.deepEqual(client.calls, ["getOrganization", "listAccessApps"]);
});

test("skips, rather than fails, when signed out or the client cannot run", async () => {
  const signedOut = await verifyAccount(memoryClient({ signedOut: true }), config, origin);
  assert.ok("skipped" in signedOut);
  const unavailable = {
    ...memoryClient(matchingAccount()),
    getOrganization: () => Promise.reject(new CfUnavailableError("could not run cf: ENOENT")),
  } satisfies CloudflareClient;
  assert.ok("skipped" in await verifyAccount(unavailable, config, origin));
});

test("keeps the Access problems it found when the storage reads are not permitted", async () => {
  const account = { ...matchingAccount(), accessApps: [] };
  const client = {
    ...memoryClient(account),
    listKvNamespaces: () => Promise.reject(new CfAuthError("[10000] Authentication error")),
  } satisfies CloudflareClient;
  const result = await verifyAccount(client, config, origin);
  assert.ok("problems" in result);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /no Access application/);
  // Nothing found before it: skipped, as for a token that reads nothing.
  const clean = { ...memoryClient(matchingAccount()), listKvNamespaces: client.listKvNamespaces } satisfies CloudflareClient;
  assert.ok("skipped" in await verifyAccount(clean, config, origin));
});

test("fails loudly on an API error that is not about credentials", async () => {
  await assert.rejects(
    problems({ ...matchingAccount(), failing: { listKvNamespaces: "[10013] internal error" } }),
    /10013/);
});
