// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    PRESENCE_READ_SECRET?: string;
    RELEASE_HOOK_SECRET?: string; // bearer token for POST /v1/releases; set with `wrangler secret put`
  }
}
interface Env {
  PRESENCE_READ_SECRET?: string;
  RELEASE_HOOK_SECRET?: string;
}
