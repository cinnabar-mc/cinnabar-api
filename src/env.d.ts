/** Optional until production crash storage and rate-limit bindings are provisioned. */
interface CrashBindings {
  CRASH_REPORTS: R2Bucket;
  CRASH_INDEX: D1Database;
  CRASH_GLOBAL_LIMIT: RateLimit;
  CRASH_IP_LIMIT: RateLimit;
  CRASH_INSTALL_LIMIT: RateLimit;
}

// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env extends Partial<CrashBindings> {
    CRASH_OWNER_SECRET?: string;
    PRESENCE_READ_SECRET?: string;
    RELEASE_HOOK_SECRET?: string; // bearer token for POST /v1/releases; set with `wrangler secret put`
  }
}
interface Env extends Partial<CrashBindings> {
  CRASH_OWNER_SECRET?: string;
  PRESENCE_READ_SECRET?: string;
  RELEASE_HOOK_SECRET?: string;
}
