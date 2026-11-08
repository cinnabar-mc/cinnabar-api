import type { ProviderIdentity } from "./auth";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** Google consent URL for a server-side authorization code exchange with S256 PKCE. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
  return url.toString();
}

/**
 * Exchanges a browser-bound code, then reads claims directly from Google's HTTPS OpenID userinfo endpoint.
 * This authenticates claims using the newly issued server-side access token, avoiding local ID-token/JWKS
 * caching and validation. No browser-supplied ID token is trusted; all tokens are discarded on return.
 */
export async function googleIdentity(options: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string;
}): Promise<ProviderIdentity> {
  const token = await fetch(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret,
      grant_type: "authorization_code", code: options.code, redirect_uri: options.redirectUri, code_verifier: options.verifier }) });
  if (!token.ok) throw new Error("Google token exchange failed");
  const { access_token: accessToken } = await token.json() as { access_token?: unknown };
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 8192) throw new Error("Invalid Google token response");
  const response = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Google userinfo failed");
  const { sub, email, email_verified, name } = await response.json() as Record<string, unknown>;
  if (typeof sub !== "string" || !sub || sub.length > 255 || typeof email !== "string" || !email || email.length > 320
    || typeof email_verified !== "boolean") throw new Error("Invalid Google identity");
  return { provider: "google", subject: sub, email: email.trim().toLowerCase(), email_verified,
    display_name: typeof name === "string" && name.trim() ? name.trim().toWellFormed().slice(0, 128) : "Cinnabar player" };
}
