import { encodeBase64Url } from "../identity";

/** Random base64url text of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Unpadded base64url SHA-256 of UTF-8 text: a PKCE S256 challenge, and the stored form of a session cookie. */
export async function sha256Base64Url(text: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** A provider-verified identity. Only trusted server-side provider adapters may supply these claims. */
export interface ProviderIdentity {
  provider: string;
  subject: string;
  email: string;
  email_verified: boolean;
}

/** A 40-bit, eight-character human code. The 32-character alphabet omits ambiguous I, O, 0 and 1. */
export function linkCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = [...crypto.getRandomValues(new Uint8Array(8))].map(n => alphabet[n & 31]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Canonical human input: case and an optional hyphen/space do not change a code's hash. */
export function normalizeLinkCode(code: string): string {
  return code.toUpperCase().replace(/[-\s]/g, "");
}

/** Compares SHA-256 base64url digests with the Worker's native constant-time primitive. */
export function equalHash(a: string, b: string): boolean {
  if (a.length !== 43 || b.length !== 43) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

export const USERNAME_RULES = "Use 3–16 ASCII letters, digits or underscores. Staff and project names are reserved.";
const RESERVED_USERNAMES = new Set(["cinnabar", "admin", "administrator", "moderator", "mod", "staff", "official",
  "support", "system", "root", "owner", "null", "undefined"]);

/** Validates a case-preserving ASCII handle, rejecting reserved names case-insensitively. */
export function validUsername(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value) && !RESERVED_USERNAMES.has(value.toLowerCase());
}
