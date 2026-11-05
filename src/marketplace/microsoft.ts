import { encodeBase64Url } from "../identity";

export const AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
export const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const XBOX_USER_URL = "https://user.auth.xboxlive.com/user/authenticate";
export const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const SCOPE = "XboxLive.signin";

/** Why a sign-in failed, as a stable code the website can explain. */
export type SignInError = "cancelled" | "no_xbox_profile" | "child_account" | "xbox_unavailable" | "failed";

export class SignInFailure extends Error {
  constructor(readonly code: SignInError) {
    super(code);
  }
}

/** Random base64url text of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The Microsoft consent URL for personal accounts, asking only for Xbox Live sign-in. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return url.toString();
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Redeems an authorization code and exchanges it for the player's Xbox identity: Microsoft access token, then an
 * Xbox user token, then an XSTS token for `http://xboxlive.com`, whose claims carry the XUID and gamertag.
 * Every token is dropped when this returns; only the identity leaves.
 */
export async function xboxIdentity(options: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<{ xuid: string; gamertag: string }> {
  const form = new URLSearchParams({
    client_id: options.clientId, grant_type: "authorization_code", code: options.code,
    redirect_uri: options.redirectUri, code_verifier: options.verifier, scope: SCOPE,
  });
  if (options.clientSecret) form.set("client_secret", options.clientSecret);
  const token = await fetch(TOKEN_URL, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
  const accessToken = (await json(token)).access_token;
  if (!token.ok || typeof accessToken !== "string") throw new SignInFailure("failed");

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const user = await fetch(XBOX_USER_URL, {
    method: "POST", headers, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${accessToken}` },
      RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
    }),
  });
  const userToken = (await json(user)).Token;
  if (!user.ok || typeof userToken !== "string") throw new SignInFailure("xbox_unavailable");

  const xsts = await fetch(XSTS_URL, {
    method: "POST", headers, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      Properties: { SandboxId: "RETAIL", UserTokens: [userToken] }, RelyingParty: "http://xboxlive.com", TokenType: "JWT",
    }),
  });
  const body = await json(xsts);
  if (!xsts.ok) {
    if (body.XErr === 2148916233) throw new SignInFailure("no_xbox_profile");
    if (body.XErr === 2148916238) throw new SignInFailure("child_account");
    throw new SignInFailure("xbox_unavailable");
  }
  const claims = (body.DisplayClaims as { xui?: { xid?: unknown; gtg?: unknown }[] } | undefined)?.xui?.[0];
  const xuid = claims?.xid;
  const gamertag = claims?.gtg;
  if (typeof xuid !== "string" || !/^[0-9]{1,20}$/.test(xuid) || typeof gamertag !== "string" || !gamertag || gamertag.length > 32) {
    throw new SignInFailure("xbox_unavailable");
  }
  return { xuid, gamertag };
}
