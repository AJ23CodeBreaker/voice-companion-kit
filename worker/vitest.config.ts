// The fast suite: pure functions, plain node, no workerd.
//
// This file exists only to keep the Durable Object tests out of it — they need
// the Workers runtime and have their own config. Without the exclude, `vitest
// run` picks up *.workers.test.ts, tries to import `cloudflare:test` in node,
// and fails.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.workers.test.ts"],
  },
});
