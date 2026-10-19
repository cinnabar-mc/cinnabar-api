import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import schema from "../schema/v1.json";

const ISSUER = "https://token.actions.githubusercontent.com";
export const COSMETICS_ADMIN_AUDIENCE = "cinnabar:cosmetics-entitlements";
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
const itemIdPattern = new RegExp(schema.$defs.CosmeticItemId.pattern);

/** Checks immutable repository identity and the exact private main-branch administration workflow. */
export function trustedPublisher(claims: JWTPayload, env: Pick<Env, "COSMETICS_REPOSITORY_ID" | "COSMETICS_ADMIN_WORKFLOW">): boolean {
  return claims.repository_id === env.COSMETICS_REPOSITORY_ID
    && claims.repository_visibility === "private"
    && claims.ref === "refs/heads/main"
    && claims.event_name === "workflow_dispatch"
    && claims.workflow_ref === env.COSMETICS_ADMIN_WORKFLOW;
}

/** Verifies a short-lived GitHub Actions identity; no client token can administer grants. */
export async function authorizePublisher(header: string | undefined, env: Env, verifier: JWTVerifyGetKey = keys): Promise<boolean> {
  if (!header?.startsWith("Bearer ") || !env.COSMETICS_REPOSITORY_ID || !env.COSMETICS_ADMIN_WORKFLOW) return false;
  try {
    const { payload } = await jwtVerify(header.slice(7), verifier, {
      issuer: ISSUER, audience: COSMETICS_ADMIN_AUDIENCE, algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "nbf", "repository_id", "workflow_ref"], maxTokenAge: "10m",
    });
    return trustedPublisher(payload, env);
  } catch {
    return false;
  }
}

/** Parses an explicit grant or revocation command without accepting account names or unknown fields. */
export function entitlementCommand(value: unknown): { xuid: string; item_ids: string[]; owned: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const command = value as Record<string, unknown>;
  if (Object.keys(command).some((key) => !["xuid", "item_ids", "owned"].includes(key))) return null;
  if (typeof command.xuid !== "string" || !/^[0-9]{1,20}$/.test(command.xuid) || typeof command.owned !== "boolean"
    || !Array.isArray(command.item_ids) || command.item_ids.length < 1 || command.item_ids.length > 256
    || command.item_ids.some((id) => typeof id !== "string" || id.length > schema.$defs.CosmeticItemId.maxLength || !itemIdPattern.test(id))) return null;
  return { xuid: command.xuid, item_ids: [...new Set(command.item_ids as string[])], owned: command.owned };
}
