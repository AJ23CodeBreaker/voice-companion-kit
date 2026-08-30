// Durable Object tests, run inside the real Workers runtime.
//
// Separate from the default `vitest run` on purpose. The tests in src/*.test.ts
// are pure functions and run in plain node in under half a second; these boot
// workerd and a real SQLite-backed DO, which is slower and needs wrangler.toml.
// Keeping them apart means the fast suite stays fast.
//
// This closes the gap eval/memory.ts documents in its own header: that the
// harness "does NOT cover that the STORAGE scopes rows by character... and
// needs the Workers runtime to test honestly."
//
// vitest-pool-workers 0.22 (the first release supporting vitest 4) exposes a
// Vite PLUGIN, `cloudflareTest`. The `defineWorkersConfig` helper from
// `@cloudflare/vitest-pool-workers/config` that every tutorial still shows was
// removed — that specifier no longer exists in the package.

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
