import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MOD_RELEASE_HOOK_SECRET: "test-mod-hook-secret", MOD_RELEASE_REPOSITORY: "example/mod",
          MOD_DOWNLOAD_BASE_URL: "https://api.test", MOD_RELEASE_PACKAGE: "example-mod", MOD_HOST_REPOSITORY: "https://github.com/example/host.git",
          ISSUER: "https://issuer.test", RELEASE_HOOK_SECRET: "test-hook-secret", PRESENCE_READ_SECRET: "test-presence-secret",
          MARKETPLACE_ORIGIN: "https://site.test", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-google-secret", OWNER_EMAILS: "2535400000009001@test.invalid",
          MARKETPLACE_SCANNER_TOKEN: "test-scanner-token",
          // Lets tests claim many jobs per day; budget tests set the ledger relative to this or use the default directly.
          SCAN_AI_DAILY_NEURONS: "1000000",
          // A throwaway Ed25519 key used only by tests; its public half is in test/marketplace.test.ts.
          MARKETPLACE_SIGNING_KEY: "MC4CAQAwBQYDK2VwBCIEIFkTQGYFBigXSCX9NjUF28CaFX5LD4Op0la7M5nlziJp",
        },
      },
    }),
  ],
});
