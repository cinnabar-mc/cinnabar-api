import { encodeBase64Url } from "../identity";

let cached: { pkcs8: string; key: Promise<CryptoKey> } | null = null;

/** Signs UTF-8 text with the marketplace's Ed25519 key (base64 PKCS#8), returning an unpadded base64url signature. */
export async function signText(pkcs8: string, text: string): Promise<string> {
  if (cached?.pkcs8 !== pkcs8) {
    const der = Uint8Array.from(atob(pkcs8.trim()), (c) => c.charCodeAt(0));
    cached = { pkcs8, key: crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]) };
  }
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, await cached.key, new TextEncoder().encode(text));
  return encodeBase64Url(new Uint8Array(signature as ArrayBuffer));
}
