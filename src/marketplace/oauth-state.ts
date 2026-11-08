import { decodeBase64, encodeBase64Url } from "../identity";

/** How long a browser may take between starting a provider sign-in and returning to the callback. */
export const OAUTH_STATE_MS = 10 * 60_000;
/** Longest `return_to` carried through sign-in; longer addresses fall back to the marketplace page so the cookie fits. */
export const MAX_RETURN_TO = 2048;
/** Binds sealed values to this one use, so no other encrypted value the API might issue opens as a pending sign-in. */
const PURPOSE = new TextEncoder().encode("cinnabar oauth state v1");
const IV_BYTES = 12;

/** A pending provider sign-in: the OAuth `state`, its PKCE verifier and where to send the browser afterwards. */
export interface PendingSignIn {
  provider: string;
  state: string;
  verifier: string;
  returnTo: string;
}

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

/**
 * The AES-256-GCM key for pending sign-in cookies, derived with HKDF-SHA256 from `secret` under a fixed purpose label.
 * The derivation is one-way, so the cookie key reveals nothing about `secret` (the release signing key).
 */
function stateKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret !== secret) {
    const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"])
      .then(material => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: PURPOSE, info: new Uint8Array() },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    cached = { secret, key };
  }
  return cached.key;
}

/**
 * Encrypts and authenticates `pending` for the browser's sign-in cookie, valid until `now` plus {@link OAUTH_STATE_MS}.
 * The verifier stays confidential and the Hub stores nothing, so starting a sign-in costs no durable write.
 */
export async function sealSignIn(secret: string, pending: PendingSignIn, now: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify({ p: pending.provider, s: pending.state, v: pending.verifier, r: pending.returnTo, e: now + OAUTH_STATE_MS }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: PURPOSE }, await stateKey(secret), plain));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return encodeBase64Url(out);
}

/**
 * Opens a cookie made by {@link sealSignIn}: the pending sign-in, `"expired"` once its lifetime has passed, or null
 * when the cookie is missing, altered, sealed under another key or not one of ours.
 */
export async function openSignIn(secret: string, cookie: string | undefined, now: number): Promise<PendingSignIn | "expired" | null> {
  const bytes = cookie ? decodeBase64(cookie, true) : null;
  if (!bytes || bytes.length <= IV_BYTES) return null;
  let value: unknown;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: PURPOSE },
      await stateKey(secret), bytes.subarray(IV_BYTES));
    value = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  const { p, s, v, r, e } = (value ?? {}) as Record<string, unknown>;
  if (typeof p !== "string" || typeof s !== "string" || typeof v !== "string" || typeof r !== "string" || typeof e !== "number") return null;
  return e > now ? { provider: p, state: s, verifier: v, returnTo: r } : "expired";
}
