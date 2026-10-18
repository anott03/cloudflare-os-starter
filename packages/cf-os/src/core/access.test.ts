import assert from "node:assert/strict";
import test from "node:test";
import {
  accessTarget,
  applicationBody,
  lookupAccess,
  setupAccess,
  type AccessTarget,
} from "./access.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const target: AccessTarget = {
  accountId: ACCOUNT,
  routerName: "acme-os",
  host: "os.example.com",
  admins: ["admin@example.com", "ops@example.com"],
};

const organization = { auth_domain: "acme.cloudflareaccess.com" };

/** A parsed `deployment.jsonc` ready for Access setup: everything but issuer and audience. */
function file(route: unknown, publicBaseUrl: string | null = null, admins = ["admin@example.com"]) {
  return {
    accountId: ACCOUNT,
    publicBaseUrl,
    workers: { router: { name: "acme-os", route } },
    access: { issuer: "https://<TEAM_NAME>.cloudflareaccess.com", audience: "<ACCESS_AUDIENCE>", admins },
  };
}

test("protects the custom domain, or the workers.dev host of publicBaseUrl", () => {
  assert.equal(accessTarget(file({ customDomain: "os.example.com" })).host, "os.example.com");
  assert.equal(accessTarget(file({ workersDev: true }, "https://acme-os.acme.workers.dev")).host,
    "acme-os.acme.workers.dev");
  assert.throws(() => accessTarget(file({ workersDev: true })), /no hostname to protect/);
});

test("needs the admins it will admit", () => {
  assert.throws(() => accessTarget(file({ customDomain: "os.example.com" }, null, ["<ADMIN_EMAIL>"])),
    /set access\.admins/);
});

test("creates a self-hosted application admitting exactly the admins", () => {
  assert.deepEqual(applicationBody(target), {
    type: "self_hosted",
    name: "Cloudflare OS acme-os",
    domain: "os.example.com",
    session_duration: "24h",
    policies: [{
      name: "Cloudflare OS admins",
      decision: "allow",
      include: [{ email: { email: "admin@example.com" } }, { email: { email: "ops@example.com" } }],
    }],
  });
});

test("reuses an application that already covers the hostname", async () => {
  const client = memoryClient({
    organization,
    accessApps: [{ name: "Existing", aud: "aud-existing", domain: "os.example.com" }],
  });
  const result = await setupAccess(client, target);
  assert.ok(result.kind === "reused", result.kind);
  assert.deepEqual(result.edits, [
    { path: ["access", "issuer"], value: "https://acme.cloudflareaccess.com" },
    { path: ["access", "audience"], value: "aud-existing" },
  ]);
  assert.deepEqual(client.created, [], "created a duplicate");
});

test("reports a covering wildcard application, but creates one naming the hostname over it", async () => {
  // The wildcard's policy admits whoever it does across example.com, wider than the admins.
  const wildcard = { name: "Wildcard", aud: "aud-wildcard", domain: "*.example.com" };
  const found = await lookupAccess(memoryClient({ organization, accessApps: [wildcard] }), target);
  assert.ok(found.kind === "missing" && found.wildcard === wildcard);
  const created = await setupAccess(memoryClient({ organization, accessApps: [wildcard] }), target);
  assert.ok(created.kind === "created" && created.wildcard === wildcard);
  assert.deepEqual(created.app.domain, applicationBody(target).domain);
  // One naming the hostname itself is reused.
  const exact = { name: "Exact", aud: "aud-exact", domain: "os.example.com" };
  const reused = await setupAccess(memoryClient({ organization, accessApps: [wildcard, exact] }), target);
  assert.ok(reused.kind === "reused" && reused.app === exact);
});

test("keeps a covering wildcard application the file already chose", async () => {
  const wildcard = { name: "Wildcard", aud: "aud-wildcard", domain: "*.example.com" };
  const client = memoryClient({ organization, accessApps: [wildcard] });
  const result = await setupAccess(client, { ...target, audience: "aud-wildcard" });
  assert.ok(result.kind === "reused" && result.app === wildcard);
  assert.deepEqual(client.created, [], "created one over the wildcard the file chose");
  // Read from the file, placeholder aside.
  assert.equal(accessTarget({ ...file({ customDomain: "os.example.com" }), access: {
    issuer: "https://acme.cloudflareaccess.com", audience: "aud-wildcard", admins: ["a@example.com"] } }).audience, "aud-wildcard");
  assert.equal(accessTarget(file({ customDomain: "os.example.com" })).audience, undefined);
});

test("does not reuse an application gating only a path of the hostname", async () => {
  const client = memoryClient({ organization, accessApps: [{ name: "Admin", aud: "x", domain: "os.example.com/admin" }] });
  assert.equal((await setupAccess(client, target)).kind, "created");
});

test("creates one when none covers it", async () => {
  const client = memoryClient({ organization, accessApps: [{ name: "Other", aud: "x", domain: "other.example.com" }] });
  const result = await setupAccess(client, target);
  assert.ok(result.kind === "created", result.kind);
  assert.deepEqual(client.created, [{ kind: "access-app", dryRun: false, body: applicationBody(target) }]);
  assert.equal(result.edits[1].value, "aud-1");
});

test("only validates the create on a dry run", async () => {
  const client = memoryClient({ organization });
  const result = await setupAccess(client, target, { dryRun: true });
  assert.ok(result.kind === "dry-run", result.kind);
  assert.equal(result.issuer, "https://acme.cloudflareaccess.com");
  assert.deepEqual(client.created.map((creation) => creation.dryRun), [true]);
});

test("says when Access cannot work yet, and points at Zero Trust setup", async () => {
  const none: MemoryAccount = { organization: null };
  const lookup = await lookupAccess(memoryClient(none), target);
  assert.equal(lookup.kind, "no-organization");
  assert.equal((await lookupAccess(memoryClient({ organization: {} }), target)).kind, "no-organization");
  await assert.rejects(setupAccess(memoryClient(none), target), /cloudflare-one\/setup/);
  await assert.rejects(lookupAccess(memoryClient({ signedOut: true }), target), /No authentication token/);
});
