# Migrating from the hosted deploy

The [hosted flow](https://os.cloudflare.app/deploy) installs the same upstream release into your
account without this repository. Ejecting to the starter means taking over that deployment.

The whole migration is **redeploy over the workers that already exist, and rebind the
resources they already use.**

Read this end to end before running `pnpm deploy`. Sections 2 and 3 are the ones that lose data if
you skip them.

The starter's pinned release should be the same as or newer than the one your instance is running,
so migrating is a version upgrade as well as a move. That means the usual upgrade caveats apply:
upstream changes can be breaking, and a newer release can carry Durable Object migrations that run
against your existing data the first time you deploy. If you want the full gate before touching
production — compatibility review, migration plan, rollback matrix — it is in
[Upgrade and rollback](../.agents/skills/cloudflare-os-operator/references/upgrade-and-rollback.md).
Do not deploy a pin *older* than what the instance runs; downgrade the code and the storage stays
migrated.

## 1. What carries over, and why

Nothing is stored *in* a Worker. Your users, gadgets, workspaces and settings live in SQLite
Durable Objects belonging to the **backend Worker's script identity**, and DO namespaces are scoped
to that identity.

So:

- Redeploying over the same script name is an in-place version update. The DOs are the same DOs and
  the data is still there.
- Deploying under a different name creates a *new* script with empty DO namespaces. The old data is
  not lost, but nothing reads it any more, and the app looks freshly installed.

KV and R2 work the same way, except that the binding names the resource explicitly — which is why
leaving `resources.*` as `null` is the trap in section 3.

## 2. Match the Worker names exactly

Find your hosted instance name — call it `N` — in the wizard, or read it off the worker list in the
[dashboard](https://dash.cloudflare.com/). The hosted flow names everything after it.

| Hosted Worker | What it holds | `deployment.jsonc` |
| --- | --- | --- |
| `N-backend` | **All user data** (Durable Objects) | `workers.workshop.name` |
| `N-gk-context` | Context collections | `workers.context.name` |
| `N-gk-scheduler` | Scheduled and recurring work | `workers.scheduler.name` |
| `N-gk-websearch` | Nothing; stateless web search | `workers.websearch.name` |
| `N` | The public URL | `workers.router.name` |

The Gatekeeper suffixes are the hosted flow's choice, not the starter's, so confirm them against
the dashboard worker list rather than assuming the pattern. An instance deployed before Web Search
shipped has no `N-gk-websearch`. Name it yourself, and the deploy creates it. Its users finished
onboarding before Web Search existed, so none of them has it until it is set to enabled in `/admin`
or they turn it on from the Gatekeepers page. The starter also deploys two
Workers the hosted flow does not: the example custom Gatekeeper and the Error Reporter. Give those
new names; nothing depends on them yet.

```jsonc
"workers": {
  // Hosted instances run on workers.dev; section 4 has the custom-domain form.
  "router": { "name": "N", "route": { "workersDev": true } },
  "workshop": { "name": "N-backend" },
  "context": { "name": "N-gk-context" },
  "scheduler": { "name": "N-gk-scheduler" },
  "websearch": { "name": "N-gk-websearch" },
  "customGatekeeper": { "name": "N-gk-custom" },
  "errorReporter": { "name": "N-errors" }
}
```

Context, Scheduler and Web Search are all there because upstream marks them ambient and the hosted
flow preinstalls them on every instance. Point them at the existing Workers and existing schedules and
collections keep working; give either a new name and the app comes up with an empty library or an
empty schedule list, while the originals keep running as Workers nothing is bound to.

## 3. Reuse the storage

`resources.*` and `context.kvNamespaceId` default to `null`, which asks Wrangler to **provision new,
empty** namespaces. On a fresh install that is what you want. On a migration it is data loss in
everything but name: the deploy succeeds, and the app comes up with no blueprints, no avatars and no
Context collections.

The hosted flow names each resource after the instance and the binding:

```jsonc
"context": {
  "sharingDomain": null,
  "kvNamespaceId": "<id of N-context-collections>"
},
"resources": {
  "blueprintsKvNamespaceId": "<id of N-blueprints>",
  "avatarsKvNamespaceId": "<id of N-avatars>",
  "blueprintContentBucket": "N-blueprint-content"
}
```

KV bindings take the namespace **ID**, not the name — list them with
`pnpm exec wrangler kv namespace list`. R2 takes the bucket name as-is.

The Scheduler needs nothing here. Its state is entirely in its own Durable Objects, so section 2's
name is the whole of it. Web Search keeps no state worth migrating.

### The second trap: the Context sharing boundary

Right KV, wrong boundary, and the collections are still invisible. `context.sharingDomain` isolates
Context data, and the hosted flow sets it to the instance's **public origin** — the router's URL,
scheme included, such as `https://N.<subdomain>.workers.dev`.

`sharingDomain: null` reproduces that: the deploy derives it from the public origin, exactly as
hosted does. So the boundary survives as long as the origin does, which makes it one more reason to
keep the URL in [section 4](#4-your-url).

If you *do* move the instance to a new hostname, the derived value changes with it. Pin the old one
instead, so the boundary stays where the data is:

```jsonc
"context": { "sharingDomain": "https://N.<subdomain>.workers.dev" }
```

`publicBaseUrl` is the other half of this. It is the origin both `sharingDomain` and
`PUBLIC_BASE_URL` derive from: leave it `null` on a custom domain and the deploy takes the domain,
but on a `workers.dev` route it must be set by hand — nothing in `deployment.jsonc` knows your
account's workers.dev subdomain. Set it to the hosted instance's exact URL, no trailing slash:

```jsonc
"publicBaseUrl": "https://N.<subdomain>.workers.dev"
```

`pnpm check` requires that value to be the router's own workers.dev origin —
`https://<workers.router.name>.<subdomain>.workers.dev` — because on this route there is no custom
domain to check it against, and a typo would quietly become both `PUBLIC_BASE_URL` and the Context
boundary.

## 4. Your URL

The starter deploys the same topology as the hosted flow, router included, so the public origin is a
Worker named `N` in both. Either route type preserves the URL:

| Hosted URL | `deployment.jsonc` |
| --- | --- |
| `https://N.<subdomain>.workers.dev` | `"router": { "name": "N", "route": { "workersDev": true } }`, plus `publicBaseUrl` set to that URL |
| A custom domain you already moved it to | `"router": { "name": "N", "route": { "customDomain": "os.example.com" } }` |

Redeploying over `N` is an in-place version update, like every other Worker here. There is no
router to strip a domain from and no router to delete, and the Access application keeps covering
the hostname it already covered.

## 5. AI Gateway — the one that silently empties the model picker

**Do not leave `aiGateway.enabled` at `false`.** `wrangler deploy` replaces a Worker's `vars`
wholesale, so the `CF_AI_GATEWAY*` variables the hosted deploy set are gone the moment you deploy
without your own. With `CF_AI_GATEWAY` unset, `getAiGatewayConfig()` returns `null`, the backend
drops out of gateway mode, and `listModels()` returns only each user's own BYOK models — of which a
freshly migrated instance has none. The result is a deployment that looks healthy and offers no
models at all.

Point it at the gateway the hosted flow already created for you, `N-ai`:

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "N-ai",
  "accountId": null,
  "providers": ["cloudflare"]
}
```

- `accountId: null` keeps the gateway in your own account, which is what lets the Workshop reach it
  over the `WORKERS_AI` binding. **No `CF_AI_GATEWAY_API_TOKEN` is needed.**
- Add `"anthropic"` or `"openai"` to `providers` if you entered BYOK keys in the wizard. Those keys
  live in the gateway's own Secrets Store, not in the Worker, so they survive the migration and keep
  working.
- Adding `"google"` does require a token — see
  [AI models](customization.md#ai-models).

Web Search does not use `N-ai`. It searches through the account's `default` gateway, fixed upstream,
which Cloudflare creates on first use. Searches need AI Gateway credits on the account or a Ceramic
key on that gateway: see [Workers and routing](customization.md#workers-and-routing).

## 6. Cloudflare Access

The hosted flow created a self-hosted Access application named `Cloudflare OS <instance> <fp8>`,
using the one-time-PIN identity provider. Reuse it rather than making a new one, so existing users
keep signing in the same way:

- `access.issuer`: your team origin, `https://<team>.cloudflareaccess.com`.
- `access.audience`: that application's existing AUD tag.
- `access.admins`: the admin email you gave the wizard.

The application already covers the hostname the router answers on, so keeping the URL keeps Access
working untouched. Only if you are moving the instance to a new hostname do you have to extend the
application to cover it — before deploying, and along with `context.sharingDomain` from section 3.

## 7. What you lose

- **The wizard link.** The hosted deploy sets a `DEPLOY_URL` var that renders a "manage this
  deployment" link. The starter does not set it, so the link disappears. This is not a regression to
  work around: the hosted wizard refuses to redeploy over its own workers once you have taken them
  over, which is the whole reason to eject.
- **Gatekeepers you installed through the wizard.** The starter deploys the three ambient ones,
  Context, Scheduler and Web Search, plus whatever is in `packages/`. Any *other* Gatekeeper the wizard
  installed keeps running as its own Worker, but the generated configs no longer carry its
  `GATEKEEPER_*` service binding, so it disappears from the app. Port it into `packages/` and add
  the binding in `scripts/deploy.ts` — to the Workshop for its vendor RPC, and to the router if it
  serves HTTP under `/gatekeeper/<name>` — or delete the orphaned Worker.

## 8. Verify

Beyond the [standard checks](../README.md#4-verify-the-deployment):

1. Sign in as an existing user and confirm the identity is recognised, not re-created.
2. Open the model picker. It must list models — an empty picker means section 5 was skipped.
3. Open a gadget that existed before the migration, and confirm its history is intact.
4. Open the Context library and confirm its collections are still listed.
5. Confirm schedules made before the migration are still listed, and that a new one fires.
6. Send one message to confirm inference actually routes.
7. Turn Web Search on for your user (section 2), then ask an agent to search the web, and confirm
   results come back.

If the model picker is empty or the app looks freshly installed, **stop before writing anything**.
Both are binding problems, not data loss: compare the deployed Worker names and resource IDs against
sections 2 and 3 rather than re-provisioning.
