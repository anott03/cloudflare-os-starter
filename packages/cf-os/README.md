# cf-os

The command line for a self-hosted [Cloudflare OS](https://github.com/cloudflare/cloudflare-os): it scaffolds a project from the [starter](https://github.com/cloudflare/cloudflare-os-starter), configures its `deployment.jsonc`, and checks and deploys it.

```sh
pnpm cf-os init                  # inside a project: configure it, then offer to deploy
pnpm cf-os check                 # validate, check the account, test, build, dry-run every deploy
pnpm cf-os deploy                # the same, then deploy for real
npx cf-os init my-os             # no clone yet: create one in ./my-os, then the same init
```

Inside the starter it is the `packages/cf-os` workspace package, and `pnpm cf-os <command>` runs it: fork or clone the starter, `pnpm install`, then `pnpm cf-os init`. `npx cf-os init` is for when you have not cloned it yet. It clones the starter's `main` branch (`--ref <branch>` and `--template <url|path>` pick another branch or a fork), installs, offers to create a private GitHub repository for it, and runs the project's own `pnpm cf-os init`.

## Commands

| Command | What it does | Account |
| --- | --- | --- |
| `init [<dir>]` | Outside a project: clones the starter into `<dir>` (`origin` renamed to `starter`), installs, offers to create a private GitHub repository with `gh` and push to it (running `gh auth login` first if needed), then configures it. Inside one: offers the `cf` sign-in, configures it as a new deployment or as the takeover of a hosted instance, and, once nothing is left as a placeholder, offers the Wrangler sign-in and to deploy. `--template`, `--ref` and `--out` | Reads; creates the Access application and a One-time PIN provider, and deploys, only if you choose to |
| `import [<instance>]` | Finds what a hosted-deploy instance runs and prints the `deployment.jsonc` values that redeploy over it. `--out <path>` writes them | Read-only |
| `access [--dry-run]` | Finds or creates the Access application for the router's hostname, and writes `access.issuer` and `access.audience` | Creates one application, unless one already covers the hostname |
| `check` | Validates the file, checks the account has what it names, runs the tests and builds, and dry-runs every deploy | Read-only |
| `deploy` | The same, then deploys every Worker. No confirmation. On the unconfigured template at a terminal, offers `init` first and then carries on | Deploys |
| `install [--check]` | Installs the `cloudflare-os` submodule's own workspace; the root `postinstall` runs it | None |

Every command takes `--config <path>` (default: `deployment.jsonc` in the project root), `--account <id>`, `--profile <name>` (passed to every `cf` call), and `--help`. It works from any directory inside the project.

## Output and prompts

Results meant for scripts are JSON on stdout: `import`'s values, `access`'s issuer and audience, and the request a `--dry-run` would send. Everything else goes to stderr. Exit codes are 0 for success, 1 for failure, and 130 for a cancelled prompt.

Questions are asked only when stdin and stdout are both terminals and `CI` is unset, the same rule `cf` follows. Every question has a flag or config equivalent. Without a terminal, a missing answer fails and names the flag to pass, and `init` points at `import` and `access` instead.

## A global `cf-os`

Installed globally, `cf-os` only scaffolds. Inside a project it hands every command to the project's own copy, so the deploy logic matches the `cloudflare-os` version the project pins, the way a global `cf` defers to a project-local one.
