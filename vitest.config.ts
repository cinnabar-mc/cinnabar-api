import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ISSUER: "https://issuer.test", RELEASE_HOOK_SECRET: "test-hook-secret", PRESENCE_READ_SECRET: "test-presence-secret",
          MARKETPLACE_ORIGIN: "https://site.test", MICROSOFT_CLIENT_ID: "test-client", OWNER_XUIDS: "2535400000009001",
          // A throwaway Ed25519 key used only by tests; its public half is in test/marketplace.test.ts.
          MARKETPLACE_SIGNING_KEY: "MC4CAQAwBQYDK2VwBCIEIFkTQGYFBigXSCX9NjUF28CaFX5LD4Op0la7M5nlziJp",
        },
      },
    }),
  ],
});
