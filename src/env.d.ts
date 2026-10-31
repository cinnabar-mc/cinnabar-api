// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    MOD_RELEASE_HOOK_SECRET?: string;
    MOD_RELEASE_REPOSITORY?: string;
    MOD_RELEASE_PACKAGE?: string;
    MOD_HOST_REPOSITORY?: string;
    PRESENCE_READ_SECRET?: string;
    RELEASE_HOOK_SECRET?: string; // bearer token for POST /v1/releases; set with `wrangler secret put`
  }
}
interface Env {
  MOD_RELEASE_HOOK_SECRET?: string;
  MOD_RELEASE_REPOSITORY?: string;
  MOD_RELEASE_PACKAGE?: string;
  MOD_HOST_REPOSITORY?: string;
  PRESENCE_READ_SECRET?: string;
  RELEASE_HOOK_SECRET?: string;
}
