import { Validator, type Schema } from "@cfworker/json-schema";
import schemaJson from "../schema/v1.json";

const schema = schemaJson as unknown as Schema & { $id: string; $defs: { Channel: { enum: string[] } } };

/** Operational defaults advertised to clients; schema defaults define their values. */
export const SERVER_PARAMETERS = Object.fromEntries(
  Object.entries(schemaJson.$defs.Welcome.properties)
    .filter(([, property]) => "default" in property)
    .map(([name, property]) => [name, (property as { default: number }).default]),
) as Required<WelcomeParameters>;

export interface WelcomeParameters {
  lookup_batch_max?: number;
  lookup_bucket_capacity?: number;
  lookup_refill_per_min?: number;
  cache_ttl_ms?: number;
  ping_interval_ms?: number;
  reconnect_max_ms?: number;
}

export const PROTOCOL = 1;
export const MAX_FRAME_BYTES = 16 * 1024;
export const FLOOD_WINDOW_MS = 10_000;
export const FLOOD_FRAME_MAX = 30;
export const FLOOD_BYTE_MAX = 64 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Ready sockets expire after three missed client heartbeat intervals. */
export const SESSION_IDLE_TIMEOUT_MS = 3 * SERVER_PARAMETERS.ping_interval_ms;
export const MAX_CONNECTIONS = 20_000;
export const MAX_CONNECTIONS_PER_IP = 8;
export const CONNECTION_RETRY_AFTER_S = 10;
export const JWKS_REFETCH_INTERVAL_MS = 60_000;
export const MAX_CONNECTIONS_PER_XUID = 4;
export const PRESENCE_LINGER_MS = 30 * 60_000;
export const LOOKUP_BUDGET_TTL_MS = 300_000;
export const RATE_LIMITED_REPLY_MAX = 3;
export const PROOF_CONTEXT = "cinnabar-api/v1/auth:";

/** WebSocket close codes the server uses. */
export const Close = {
  invalidPayload: 1007,
  policyViolation: 1008,
  tooBig: 1009,
  unauthorized: 4401,
  stayAway: 4429,
} as const;

export type Channel = "stable" | "beta" | "nightly";
export const CHANNELS = schema.$defs.Channel.enum as readonly Channel[];

export interface Hello {
  type: "hello";
  protocol: 1;
  client_version: string;
  client_build?: number;
  channel: Channel;
  visible: boolean;
  token: string;
}
export interface Proof {
  type: "proof";
  signature: string;
}
export interface Visibility {
  type: "visibility";
  visible: boolean;
}
export interface Lookup {
  type: "lookup";
  id: number;
  xuids?: string[];
  uuids?: string[];
}
export interface EmoteState {
  type: "emote_state";
  emote_id: string | null;
  elapsed_ms: number;
  xuids?: string[];
  uuids?: string[];
}
export interface LoadoutState {
  type: "loadout";
  revision: number;
  slots: Record<string, string | null>;
}
export const EMOTE_TTL_MS = schemaJson.$defs.Emote.properties.valid_for_ms.maximum;

export interface ReleaseRecord {
  channel: Channel;
  version: string;
  build?: number;
  published_at: string;
}
export interface ReleaseHookRequest {
  channel: Channel;
  version: string;
  build?: number;
}

export type ServerMessage =
  | ({ xuid: string; uuid: string } & LoadoutState)
  | { type: "challenge"; nonce: string }
  | ({ type: "welcome"; xuid: string; loadout_revision?: number } & WelcomeParameters)
  | { type: "error"; code: "unauthorized" | "invalid_loadout" }
  | { type: "error"; code: "rate_limited"; id: number }
  | { type: "lookup_result"; id: number; cinnabar: string[]; cinnabar_uuids?: string[] }
  | ({ type: "release" } & ReleaseRecord)
  | { type: "emote"; xuid: string; uuid: string; emote_id: string | null; elapsed_ms: number; valid_for_ms: number };

interface ClientMessages {
  hello: Hello;
  proof: Proof;
  visibility: Visibility;
  lookup: Lookup;
  emote_state: EmoteState;
  loadout: LoadoutState;
}
export type ClientMessage = ClientMessages[keyof ClientMessages];

const defNames = { hello: "Hello", proof: "Proof", visibility: "Visibility", lookup: "Lookup", emote_state: "EmoteState", loadout: "LoadoutState" } as const;

/** Returns a validator for one `$defs` entry of schema/v1.json, so the schema stays the single source of limits. */
function validatorFor(def: string): Validator {
  const validator = new Validator({ $ref: `${schema.$id}#/$defs/${def}` }, "2020-12");
  validator.addSchema(schema);
  return validator;
}

const clientValidators = Object.fromEntries(
  Object.entries(defNames).map(([type, def]) => [type, validatorFor(def)]),
) as Record<keyof ClientMessages, Validator>;
const hookValidator = validatorFor("ReleaseHookRequest");
const channelValidator = validatorFor("Channel");

/** Result of decoding one inbound text frame. */
export type Decoded =
  { kind: "message"; message: ClientMessage } | { kind: "unknown" } | { kind: "malformed" } | { kind: "invalid" };

/**
 * Decodes a text frame: `malformed` when it isn't a JSON object with a string `type`, `unknown` for types
 * v1 doesn't define, `invalid` for a known type that fails its schema.
 */
export function decodeClientMessage(text: string): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "malformed" };
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return { kind: "malformed" };
  if (!Object.hasOwn(clientValidators, type)) return { kind: "unknown" };
  if (!clientValidators[type as keyof ClientMessages].validate(value).valid) return { kind: "invalid" };
  if (type === "lookup" || type === "emote_state") {
    const lookup = value as Lookup;
    if ((lookup.xuids?.length ?? 0) + (lookup.uuids?.length ?? 0) > SERVER_PARAMETERS.lookup_batch_max) {
      return { kind: "invalid" };
    }
  }
  return { kind: "message", message: value as ClientMessage };
}

export function isReleaseHookRequest(value: unknown): value is ReleaseHookRequest {
  return value !== undefined && hookValidator.validate(value).valid;
}

export function isChannel(value: unknown): value is Channel {
  return value !== undefined && channelValidator.validate(value).valid;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Orders two schema-valid versions by SemVer 2.0 precedence; negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error("compareVersions: not a schema version");
  for (let i = 1; i <= 3; i++) {
    const d = compareNumeric(pa[i]!, pb[i]!);
    if (d !== 0) return d;
  }
  const preA = pa[4];
  const preB = pb[4];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const x = ia[i]!;
    const y = ib[i]!;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    let d: number;
    if (xNum && yNum) d = compareNumeric(x, y);
    else if (xNum !== yNum) d = xNum ? -1 : 1;
    else d = x < y ? -1 : x > y ? 1 : 0;
    if (d !== 0) return d;
  }
  return Math.sign(ia.length - ib.length);
}

function compareNumeric(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
