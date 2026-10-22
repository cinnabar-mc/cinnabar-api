import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import local from "./crash-bindings.local.json";

// Test bindings use the same local-only fixture values as the Wrangler harness.
const r2Buckets = local.r2_buckets.map((entry: { binding: string }) => entry.binding);
const d1Databases = local.d1_databases.map((entry: { binding: string }) => entry.binding);
const ratelimits = Object.fromEntries(local.ratelimits.map(
  (entry: { name: string; namespace_id: string; simple: { limit: number; period: number } }) =>
    [entry.name, { namespace_id: entry.namespace_id, simple: { ...entry.simple, period: entry.simple.period as 10 | 60 } }],
));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        r2Buckets, d1Databases, ratelimits,
        bindings: { ISSUER: "https://issuer.test", RELEASE_HOOK_SECRET: "test-hook-secret", PRESENCE_READ_SECRET: "test-presence-secret", CRASH_OWNER_SECRET: "test-crash-owner" },
      },
    }),
  ],
});
