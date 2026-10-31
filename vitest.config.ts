import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ISSUER: "https://issuer.test", RELEASE_HOOK_SECRET: "test-hook-secret", MOD_RELEASE_HOOK_SECRET: "test-mod-hook-secret", MOD_RELEASE_REPOSITORY: "example/mod", MOD_RELEASE_PACKAGE: "example-mod", MOD_HOST_REPOSITORY: "https://github.com/example/host.git", PRESENCE_READ_SECRET: "test-presence-secret" },
      },
    }),
  ],
});
