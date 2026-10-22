import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ISSUER: "https://issuer.test", RELEASE_HOOK_SECRET: "test-hook-secret", PRESENCE_READ_SECRET: "test-presence-secret", CRASH_OWNER_SECRET: "test-crash-owner" },
      },
    }),
  ],
});
