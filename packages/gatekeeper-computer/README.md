# Computer Gatekeeper

Experimental, disabled by default, and not connected to the deployment. Cloudflare Computer 0.3.1 is preview software, not suitable for production. This package has not been exercised end to end with a container or GitHub.

Agents use this connector to import source, edit files, install dependencies, build, test, and create local Git commits. The existing GitHub Gatekeeper keeps GitHub authentication, branch pushes, and pull requests. No GitHub token enters a sandbox.

## Components

- `src/gatekeeper.ts` implements the account, private connection, sandbox capabilities, observations, and queued actions.
- `src/sandbox.ts` owns one Computer filesystem and Linux container per sandbox. Durable Object alarms execute jobs and stop idle containers.
- `src/git.ts` exports local commits and their objects into the OS Git cache.
- `src/account-state.ts` owns the account's sandbox registry, quota, and durable management operations. `src/management.ts` is the account UI's RPC capability, and `manager/` is its page, bundled into `src/generated/manager.txt` by `build-manager.ts` during builds.
- `src/storage.ts` stores bounded Git packs outside the sandbox filesystem so agents cannot modify retained exports.
- `src/execution.ts` runs commands with an explicit environment (CA trust, Playwright browsers, no Git prompts) and writes files with created parent directories.
- `Dockerfile` includes Node 24, pnpm, Git, Python, build tools, and Playwright 1.63.0 with Chromium headless shell. computerd is pinned to 0.3.1.
- `browser/screenshot.ts` captures a local app in a fresh browser context. Browser binaries are downloaded at image build time, not from sandbox jobs.
- `src/types.d.ts` is the agent API. `src/types.txt` is a symlink to it.

The local change in `cloudflare-os/packages/gatekeeper-github/src/` adds `GitHubRepo.exportCheckout()`. It reuses the existing authenticated Git transport and records the base commit in that connection's OS cache. It then returns a shallow pack containing the complete tree. Existing `push()` and `createPullRequest()` are unchanged.

Use both connections in the same OS workspace. A checkout exported in a different workspace does not establish the destination ancestry proof needed for a later push.

## Agent workflow

Each mutating operation returns a queued job, except `createSandbox()`, which returns a sandbox whose initial state is `pending`. Approval accepts a job into the sandbox's durable FIFO queue; it does not wait for the current job to finish. Up to 16 approved jobs can wait behind one active job. Jobs run in approval order, and their execution timeouts exclude queue wait time. `queued` can mean awaiting approval or waiting behind earlier approved work. Command output is real, never simulated.

Check that sandbox creation has completed before submitting work. Later approved jobs still run after a job fails or is cancelled, so wait for success before submitting dependent work, or combine dependent shell steps with `&&`. Cancelling an approved waiting job removes only that job. Cancelling the running job stops sandbox processes, then lets the remaining queue continue. Applying `stop()` or `destroy()` cancels the running job and all approved waiting jobs. These operations do not resolve actions still awaiting approval in CFOS, and commands approved after a stop can restart the sandbox.

1. Call `COMPUTER.createSandbox("feature-work")`. Save its `info().id`, then reopen it with `openSandbox(id)` in later sessions.
2. Wait until `info().state` is `ready` or `stopped`.
3. Call the connected repository's `exportCheckout("main")`, then pass that result to `sandbox.checkout(source, "/workspace/repo")`. The checkout contains a real `.git` directory, a detached HEAD, and a shallow boundary at the imported commit.
4. Edit with `writeFile()` or shell commands. Run package installation, builds, and tests with `exec(command, { cwd: "/workspace/repo", timeoutMs: 300000 })`.
5. Save each `job.status().id`; reading `job.id` directly yields an RPC property, not a plain string. Use `getJob(id)`, `status()`, and paginated `output()` across sessions. Do not infer success from empty output; require `state: "completed"` and `exitCode: 0`.
6. Create a local commit using Git, supplying your intended author name and email. Nothing configures a guessed identity or GitHub remote credentials.
7. Submit `sandbox.stop()` and wait for completion. This prevents background processes from changing Git objects during export. Files synchronized after a completed command remain durable; unsynchronized background writes may be lost.
8. Call `sandbox.exportCommit("/workspace/repo")`. This imports the commit and its file objects into OS and returns its full commit ID. It does not push to GitHub.
9. Call the GitHub connection's `push("feature-branch", commitId)`, followed by `createPullRequest({ head: "feature-branch", base: "main", title: "...", bodyMarkdown: "..." })`. Follow the GitHub connection's type declarations for PR options and its normal approval flow.
10. Submit `sandbox.destroy()` when finished and wait for its job. The account's sandbox slot is released once deletion is observed, by `info()`, a later sandbox creation, or the Sandboxes manager. Exported packs remain in the connection for OS cache refill and pending pushes.

The container does not receive a GitHub network credential, so `git push`, `gh`, and private `git clone` cannot replace steps 3 and 9. Public cloning through `exec()` is subject to egress policy; only repositories imported through `checkout()` can use `exportCommit()`.

A checkout import occupies one of the connection's two staging slots until its approval is applied or cancelled. Interrupted uploads are swept automatically on the next session use, so an abandoned stream no longer blocks new checkouts. `COMPUTER.listStagedCheckouts()` lists the pending imports, including one still receiving its pack or whose sandbox was deleted, and `COMPUTER.cancelStagedCheckout(jobId)` cancels one through the normal approval flow.

## Screenshots and image output

Screenshots are optional tools, not a prescribed workflow. Agents can capture a viewport, a full page, or one element whenever useful, and choose which captures to show. They can keep before/after captures, inspect individual components, or capture several viewport sizes without an automatic comparison step.

`sandbox.screenshot(options)` returns a normal queued job. It uses the existing `computer.exec` auto-approval category because loading a page executes scripts and can modify local app data. It does not start a server, change code, or create a public preview. Start the app separately with `exec()`, detach it and redirect its standard streams if it must remain running after that command finishes, then ensure it is ready. A foreground server that occupies the current job will keep a screenshot waiting behind it.

Capture options include `url`, `viewport`, `fullPage`, `selector`, `waitForSelector`, and `timeoutMs`. A fresh context has no saved cookies or login state. The URL must use local HTTP with an explicit port from 1024 to 65535, excluding computerd's port 8080. Browser requests and WebSockets are limited to the selected origin; HTTP redirects and service workers are blocked. Use the final URL directly, bundle assets locally, and start separate captures to visit other local app ports. The app server's own outbound requests still use the existing sandbox egress policy.

```ts
const job = await sandbox.screenshot({
  url: "http://127.0.0.1:3000/review",
  viewport: { width: 1280, height: 800 },
  waitForSelector: "[data-ready]",
});
console.log(await job.status());
```

Save the job ID and poll `getJob(id).status()`. After it completes, `sandbox.readScreenshot(id)` returns private PNG bytes. CFOS's `executeCode` function now accepts an optional fourth argument, `output`, for image output:

```ts
export default async function(self, env, ctx, output) {
  const sandbox = await env.COMPUTER.openSandbox("sandbox-id");
  const image = await sandbox.readScreenshot("completed-screenshot-job-id");
  await output.image({ ...image, name: "Review panel.png" });
}
```

Images appear in chat using the existing attachment preview. Image-capable models receive the PNG as an image tool result, including on subsequent turns. Text-only models receive a note that the image is visible to the user, not the pixels. Do not print base64 image data to the console.

PNG output is limited to 1 MiB, 4096 × 8192 maximum dimensions, and 8 megapixels. Viewports are limited to 2048 pixels per dimension. Capture execution is limited to 60 seconds. CFOS accepts at most four images and 1 MiB total per agent step. Crop an element or reduce the viewport when a capture exceeds these limits.

Each sandbox retains at most 32 screenshot artifacts. Reads use the owning connection's observation checks. Destroying a sandbox removes its screenshot copies, but images already emitted into CFOS remain private chat attachments until that chat is deleted. No R2 bucket, presigned URL, or public image endpoint is created. Screenshots can contain confidential UI data; emitting them sends that data to the configured image-capable model provider. They are agent-produced artifacts, not tamper-proof evidence.

This feature also changes `cloudflare-os/packages/workshop-shared`, `workshop-backend`, and `workshop-frontend`. Deployment requires the Computer image/Worker and the CFOS stack. A Computer-only deployment can capture PNGs but cannot add image output to an older CFOS agent runtime.

## Runtime environment and tooling

Every executed command and its child processes receive an explicit environment: `NODE_EXTRA_CA_CERTS` pointing at the Cloudflare container CA, `PLAYWRIGHT_BROWSERS_PATH` pointing at the installed Chromium, and `GIT_TERMINAL_PROMPT=0`. Node-based tools get TLS trust and browser discovery without per-command variables. The system trust store includes the same CA for other runtimes.

The image ships Node 24, pnpm 11, Git, Python 3 with venv, build-essential, curl, and ps. `gh` is not included.

Package-manager friction worth knowing:

- pnpm 11 reads build-script approval from the project's `pnpm-workspace.yaml` (`onlyBuiltDependencies`); the `pnpm` field in package.json is ignored, and `pnpm approve-builds` is interactive-only, so it cannot run in a queued command.
- `pnpm exec <tool>` verifies dependencies first. If the install recorded ignored build scripts (esbuild, sharp, workerd), it exits with `ERR_PNPM_IGNORED_BUILDS` even though the binaries work. Put the list in `pnpm-workspace.yaml` before installing, or reinstall after adding it.
- To bypass the pre-exec check, run the tool's real entry point directly, for example `node node_modules/astro/bin/astro.mjs dev`. pnpm's symlinked layout differs from npm's, so an npm-style path may not exist; resolve the entry from the package's `bin` field.

Cloudflare dev runtimes (`wrangler dev`, `@astrojs/cloudflare`, and similar) use SQLite locking that fails on the /workspace FUSE mount with `database is locked: SQLITE_BUSY`. Copy the project to the container's root disk, for example `/root/site`, and run the dev server there. Copy changed files back under `/workspace` before stopping or exporting: only `/workspace` is durable, and `writeFile()`/`readFile()` cannot reach `/root`.

## Sandbox manager

The Computer account provides a **Sandboxes** management page, hosted by CFOS at `/gatekeepers/computer` and listed with other connector apps. It covers every sandbox reserved by that account, including sandboxes from deleted chats, workspaces, or workspace connections. Agents cannot call it; it is not part of the `ComputerSession` API.

The page shows each sandbox's name, creating workspace, creation time, running or stopped state, active job, queued-job count, and the account's slot usage. Sandboxes created before the manager existed show their ID with an unknown name and workspace. The page never infers ownership from other data.

- **Stop** cancels the running job and approved queued jobs and stops the container. Files and the quota slot are retained.
- **Delete** requires an inline confirmation. It cancels approved work, stops the container, deletes workspace files and screenshots, then releases the slot automatically.

Operations run from a durable per-account queue and retry until the sandbox accepts them, so closing the page does not abandon a deletion. The last 100 completed operations are kept as history. The page refreshes itself while work or operations are pending.

Deletion does not remove exported Git packs, job records, images already attached to CFOS chats, or CFOS actions still awaiting approval. There is no automatic expiry or bulk deletion. A deleted, revoked, or replaced Computer account cannot manage another account's sandboxes; each sandbox also records its owning account and rejects operations from others.

CFOS previously cached an auto-provisioned account's description only when creating it. The local `workshop-backend/src/user.ts` change refreshes those descriptions once per user object lifetime, best-effort, so existing Computer accounts gain the Sandboxes page after CFOS is redeployed. Do not disconnect and reconnect Computer to reveal the page: that creates a new account without access to the old account's sandboxes.

## Authority and defaults

`COMPUTER_ENABLED` is `false`. The Worker has no public route, no workers.dev address, and no Preview URLs. Its HTTP handler always returns 404. Agent access uses OS capabilities, not a public shell endpoint.

Once enabled, the vendor supports OS's optional account provisioning and supplies a sandbox factory to the connected user's workspace. Administrators must choose the optional mode deliberately; this package does not change that policy. Sandbox IDs are looked up in the owning connection's registry, not treated as bearer authority. A sandbox object grants full execution authority within that sandbox. Selecting an existing sandbox as an independent resource in the connection UI is not implemented.

All mutations pass through `submitAction()` and execute only from `applyAction()`. Shell commands and local screenshot captures are eligible for auto-approval, using the `computer.exec` action kind, labeled "Run arbitrary sandbox commands". Both require manual approval unless the user opts in through CFOS. Creation, file writes through `writeFile()`, checkout, cancellation, stop, and destruction retain their manual approval requirements. GitHub approvals are unchanged. Reads, output, and Git exports authorize observations. Other users cannot observe the connection. Account revocation blocks further access and stops its registered sandboxes without deleting their durable data.

To stop reviewing individual shell commands, redeploy this Worker and submit a new `exec()` action. Choose **Always approve this type** on its approval card and confirm. The rule covers shell commands and screenshot captures across the sandboxes in that workspace's Computer connection, not just the current sandbox or command. Commands remain audited, and timeouts, quotas, egress, and ownership checks remain enforced. Auto-approval does not mean the job has finished; continue polling its status. Previously submitted actions retain their original approval metadata.

Arbitrary shell commands can overwrite or delete workspace files, run package scripts, spend compute, and send data to allowed hosts. Manual approval on `writeFile()` does not protect files from shell commands. Remove the rule under **Activity → Auto-approval** to require review for future commands. Removing it does not cancel jobs already approved or undo their effects.

`EGRESS_HOSTS` is an empty comma-separated string, so network access is denied initially. Configuring hosts selects Computer's HTTP gateway mode, with direct internet access disabled. The gateway permits only HTTPS GET and HEAD to exact configured hostnames, strips request headers, and does not follow redirects itself. A redirect followed by the container must pass through the gateway again. Package managers may need several approved registry/CDN hosts; POST-based audit services and private registry credentials are not supported.

An allowed hostname can still receive source code in URLs. This is not a read-only network guarantee. Review egress before importing confidential repositories. Hostnames, command text, and source contents are not written to Worker console logs by this package, but commands and file replacements appear in OS's action review. Never put credentials in commands or file writes.

Default limits:

| Limit | Default |
| --- | --- |
| Concurrent running containers across the Worker | 10 |
| Reserved sandboxes per connected account and per connection | 10 |
| Approved waiting jobs per sandbox | 16, plus one active job |
| Command timeout | At most 5 minutes, excluding queue wait time |
| Idle shutdown after a job | 10 minutes |
| Captured output per job | 256 KiB |
| Screenshot artifacts per sandbox | 32 |
| Encoded PNG size | 1 MiB |
| Decoded PNG pixels | 8 megapixels |
| Screenshot execution timeout | At most 60 seconds |
| File read/write per call | 64 KiB |
| Incoming Git pack | 64 MiB |
| Checkout pack staging | 5 minutes, including transfer |
| Pending checkouts per connection | 2 |
| Exported object content per export | 16 MiB |
| Objects per export | 10,000 |
| Individual exported Git object | 1 MiB, matching the pinned OS cache |
| Exports per connection | 16 |
| Submitted actions per connection | 1,000 |

These bound individual operations, not total account billing or all retained storage. Limits that protect export processing are not user-adjustable. Package installation may create many files or exhaust container memory and workspace storage. Interrupted jobs are not automatically replayed, because arbitrary commands may have already performed side effects. After interruption recovery stops the old container and marks its active job failed, later approved jobs continue from the durable queue. Existing active jobs from the single-job implementation use the same storage key and do not require a data reset. Job records persist; running processes do not have a restart guarantee.

Git exports preserve object IDs and follow all parent chains back to the imported base. They include binary blobs, executable modes, and symlinks. Exports fail on oversized objects, including unchanged ones in the base tree. Submodules remain gitlinks, and LFS files remain pointers. Private dependencies, submodule checkout, rebasing onto newer remote history, forks, and artifact/preview serving need additional work. Shell commands can manipulate the entire container; `/workspace` path checks on file helpers are not a shell confinement boundary.

## Local verification

Use pnpm from the starter root:

```sh
pnpm install
pnpm --dir packages/gatekeeper-computer run types:generate
pnpm --dir packages/gatekeeper-computer run build
pnpm --dir packages/gatekeeper-computer run build:worker
pnpm --dir cloudflare-os/packages/gatekeeper-github exec tsc --noEmit
```

`types:generate` uses the source entrypoint rather than the transformed build directory. Its temporary config is removed in a finally block.

A Worker-only dry-run, without building the image:

```sh
pnpm --dir packages/gatekeeper-computer exec wrangler deploy --dry-run --containers-rollout none
```

A full dry-run requires a working Docker daemon:

```sh
pnpm --dir packages/gatekeeper-computer exec wrangler deploy --dry-run
```

Neither dry-run verifies live GitHub authorization, the Computer sync protocol, cancellation across failures, or runtime isolation. Package tests (`pnpm --dir packages/gatekeeper-computer test`) run in workerd against the real Gatekeeper facet and Workspace runtime: staging recovery and cancellation, pack storage cleanup, the explicit execution environment, file writes with created parents, and screenshot failure diagnostics. The GitHub export spool is covered by the GitHub Gatekeeper's own suites. No test runs a live container or GitHub. The screenshot image builds locally. Disposable Docker smoke checks passed for viewport, element, and full-page captures, external-resource blocking, forbidden URL rejection, redirect blocking, and a missing-selector timeout. These checks used no external network or published ports. The screenshot feature also passes local type checks for `workshop-shared`, `workshop-backend`, and `workshop-frontend`. Capture through Computer's live synchronization protocol, private chat display, model image input, and replay still need end-to-end verification.

## Before deployment

Deployment and enablement require separate approval. Do not enable this on the production account based on type checks alone.

1. Review and pin the GitHub source changes in the upstream fork/submodule. The starter currently pins the original upstream commit; uncommitted submodule edits will not survive a fresh checkout.
2. Choose an evaluation Worker identity, account, container size, compute/storage budget, egress hosts, and intended users. Do not reuse an existing Worker name without confirming ownership.
3. Build the image and exercise the complete checkout, edit, test, commit, export, push, and PR flow against a disposable repository. Verify both private repository authorization and denial for a second identity.
4. Verify queued actions do not start before approval and run serially in approval order. Check queue overflow, cancellation of waiting and running jobs, stop/destroy with queued work, restart recovery without replaying interrupted commands, and Git export rejection while jobs are queued. Also verify rejection, retry after failure, revocation, idle shutdown, cross-connection ID denial, denied hosts, redirects, and raw TCP blocking.
5. Exercise untrusted Git packs and `.git` files. The byte/object limits do not prove that malformed compressed Git data cannot exhaust the Worker's memory during parsing.
6. Review Computer's private RPC plumbing and mixed capnweb dependency versions in a live Workers runtime. The Computer package carries its own capnweb dependency; this package does not force an unreviewed version override.
7. After approval, deploy the updated GitHub Worker and separate Computer Worker. The starter's deployment script does not build or deploy this new package. Add an approved `GATEKEEPER_COMPUTER` service entry through the existing `extraGatekeepers` configuration only when the target Worker is ready, then set the connector to optional for the intended users.

There is no new GitHub OAuth app or token to install. Disabling the connector does not undo a push, cancel all already-running work by itself, or delete stored files. Account revocation stops registered sandboxes; do not delete DO migrations or Worker identities as rollback. Keep the old GitHub method available while any Computer workflow relies on it.
