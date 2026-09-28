import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        bindings: { COMPUTER_ENABLED: true, MAX_SANDBOXES: 4 },
        durableObjects: {
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          COMPUTER_GATEKEEPER: { className: "ComputerGatekeeper", useSQLite: true },
          ACCOUNTS: { className: "ComputerAccountState", useSQLite: true },
          SANDBOXES: { className: "UnusedSandbox", useSQLite: true },
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"], testTimeout: 30_000 },
});
