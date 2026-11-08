// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    MARKETPLACE_SCANNER_TOKEN?: string; // isolated scanner: claim/read/complete only, never an admin or signing key
    MOD_RELEASE_HOOK_SECRET?: string;
    MOD_RELEASE_REPOSITORY?: string;
    MOD_RELEASE_PACKAGE?: string;
    MOD_HOST_REPOSITORY?: string;
    PRESENCE_READ_SECRET?: string;
    RELEASE_HOOK_SECRET?: string; // bearer token for POST /v1/releases; set with `wrangler secret put`
    GOOGLE_CLIENT_SECRET?: string; // Google web OAuth client secret
    MARKETPLACE_SIGNING_KEY?: string; // base64 PKCS#8 Ed25519 key that signs approved mod releases; HKDF also derives the sign-in cookie key from it
    // Marketplace variables, unset until the website's domain and Google client exist; web sign-in answers 503 until then.
    MARKETPLACE_ORIGIN?: string; // the website origin allowed to call marketplace routes with credentials
    GOOGLE_CLIENT_ID?: string; // Google web OAuth client ID
    OWNER_EMAILS?: string; // comma-separated verified account emails that hold the owner role
  }
}
interface Env {
  MARKETPLACE_SCANNER_TOKEN?: string;
  MOD_RELEASE_HOOK_SECRET?: string;
  MOD_RELEASE_REPOSITORY?: string;
  MOD_RELEASE_PACKAGE?: string;
  MOD_HOST_REPOSITORY?: string;
  PRESENCE_READ_SECRET?: string;
  RELEASE_HOOK_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MARKETPLACE_SIGNING_KEY?: string;
  MARKETPLACE_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  OWNER_EMAILS?: string;
}
