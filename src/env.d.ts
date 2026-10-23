// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    PRESENCE_READ_SECRET?: string;
    RELEASE_HOOK_SECRET?: string; // bearer token for POST /v1/releases; set with `wrangler secret put`
    MICROSOFT_CLIENT_SECRET?: string; // optional; the Entra app may be a public client using PKCE alone
    MARKETPLACE_SIGNING_KEY?: string; // base64 PKCS#8 Ed25519 key that signs approved mod releases
    // Marketplace variables, unset until the website's domain and Microsoft app exist; web sign-in answers 503 until then.
    MARKETPLACE_ORIGIN?: string; // the website origin allowed to call marketplace routes with credentials
    MICROSOFT_CLIENT_ID?: string; // Entra app (personal accounts) used for Xbox sign-in
    OWNER_XUIDS?: string; // comma-separated XUIDs that hold the owner role
  }
}
interface Env {
  PRESENCE_READ_SECRET?: string;
  RELEASE_HOOK_SECRET?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MARKETPLACE_SIGNING_KEY?: string;
  MARKETPLACE_ORIGIN?: string;
  MICROSOFT_CLIENT_ID?: string;
  OWNER_XUIDS?: string;
}
