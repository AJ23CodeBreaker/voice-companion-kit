// Types for the `cloudflare:test` module used by src/*.workers.test.ts.
//
// The module only exists inside workerd, so tsc cannot find it without this
// reference. Shipped by the pool package under its `./types` export.

/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
  // The bindings from wrangler.toml, as the pool provides them to a test.
  interface ProvidedEnv extends Env {}
}
