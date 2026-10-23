import contract from "../../.generated/contract.json";

/** Reach levels, from least to most of a player's game a mod can touch. */
export const RUNGS = ["looks", "reads", "watches", "acts", "network"] as const;
export type Reach = 0 | 1 | 2 | 3 | 4;

export type Role = "player" | "moderator" | "admin" | "owner";
const ROLE_RANK: Record<Role, number> = { player: 0, moderator: 1, admin: 2, owner: 3 };
export const ROLES = Object.keys(ROLE_RANK) as Role[];

/**
 * The client's `ModGrants` capabilities (crates/mod-host/src/grants.rs) and the rung each is filed under.
 * Every capability the client marks sensitive sits on Acts or Network.
 */
const groups = [
  ["environment", "hud", "settings", "render", "world_draw", "render_material", "render_post", "render_depth", "fullbright"],
  ["terrain", "player_state", "entities", "items", "recipes", "screen"],
  ["players", "entity_observe", "entity_highlight", "block_highlights", "render_through_walls"],
  ["camera", "controls", "keys", "item_use", "movement", "interaction", "inventory", "commands"],
];
// Presentation groups only; unknown/new client permissions default to the highest review gate.
export const CAPABILITY_RUNG: Readonly<Record<string, Reach>> = Object.fromEntries(contract.capabilities.map(cap => {
  const group = groups.findIndex(names => names.includes(cap.name));
  return [cap.name, (group < 0 || (cap.sensitive && group < 3) ? 4 : group) as Reach];
}));

export type Grants = Record<string, boolean | string[]>;

/** An account as the marketplace sees it. */
export interface Actor {
  xuid: string;
  role: Role;
  suspended: boolean;
}

/** The parts of a version review decisions depend on. */
export interface ReviewState {
  creator: string;
  status: "submitted" | "approved" | "changes" | "rejected";
  reach: Reach;
  approvals: { xuid: string; admin: boolean }[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Lists requested capability names, throwing on unknown names or malformed values. */
export function requestedCapabilities(grants: unknown): string[] {
  if (grants === null || grants === undefined) return [];
  if (typeof grants !== "object" || Array.isArray(grants)) throw new Error("Grants must be an object");
  const names: string[] = [];
  for (const [name, value] of Object.entries(grants)) {
    if (!Object.hasOwn(CAPABILITY_RUNG, name)) throw new Error(`Unknown capability: ${name}`);
    if (name === "commands") {
      if (!Array.isArray(value) || value.some((c) => typeof c !== "string" || !c || c.length > 64) || value.length > 64) {
        throw new Error("Commands must be a list of names");
      }
      if (value.length) names.push(name);
    } else if (typeof value !== "boolean") {
      throw new Error(`${name} must be true or false`);
    } else if (value) names.push(name);
  }
  return names;
}

/** The highest rung any requested capability reaches; a mod asking for nothing sits on Looks. */
export function reachOf(grants: unknown): Reach {
  return requestedCapabilities(grants).reduce<Reach>((top, name) => Math.max(top, CAPABILITY_RUNG[name]!) as Reach, 0);
}

/** How many distinct staff approvals a reach needs, and whether one must come from an admin. */
export function approvalRule(reach: Reach): { count: number; admin: boolean } {
  if (reach >= 4) return { count: 2, admin: true };
  if (reach === 3) return { count: 1, admin: true };
  return { count: 1, admin: false };
}

/** Whether an actor's role is at least `role`. */
export function atLeast(actor: Actor | null, role: Role): boolean {
  return !!actor && ROLE_RANK[actor.role] >= ROLE_RANK[role];
}

const deny = (reason: string): Verdict => ({ ok: false, reason });

/** Whether `actor` may review (approve, reject or ask for changes on) `version`. */
export function canReview(actor: Actor | null, version: ReviewState): Verdict {
  if (!actor) return deny("Sign in with Microsoft first.");
  if (actor.suspended) return deny("Your account is suspended.");
  if (!atLeast(actor, "moderator")) return deny("Only staff review mods.");
  if (version.creator === actor.xuid) return deny("You can't review your own mod.");
  if (version.status !== "submitted") return deny("This version isn't waiting for review.");
  if (version.approvals.some((a) => a.xuid === actor.xuid)) return deny("You've already approved this version.");
  return { ok: true };
}

/** Whether `actor`'s approval is allowed now; the last required approval of an admin-gated reach must be an admin's. */
export function canApprove(actor: Actor | null, version: ReviewState): Verdict {
  const review = canReview(actor, version);
  if (!review.ok) return review;
  const rule = approvalRule(version.reach);
  const hasAdmin = version.approvals.some((a) => a.admin);
  const last = version.approvals.length + 1 >= rule.count;
  if (rule.admin && last && !hasAdmin && !atLeast(actor, "admin")) {
    const label = version.reach >= 4 ? "Network" : "Acts";
    return deny(`${label} mods need an admin's approval.`);
  }
  return { ok: true };
}

/** Whether the approvals recorded so far satisfy the reach's rule. */
export function approvalsComplete(reach: Reach, approvals: { admin: boolean }[]): boolean {
  const rule = approvalRule(reach);
  return approvals.length >= rule.count && (!rule.admin || approvals.some((a) => a.admin));
}

/** Who may assign `role` to `target`: admins manage moderators, only owners manage admins, owners come from config. */
export function canSetRole(actor: Actor | null, target: Actor, role: Role): Verdict {
  if (!actor) return deny("Sign in with Microsoft first.");
  if (!atLeast(actor, "admin") || actor.suspended) return deny("Only admins manage staff.");
  if (target.xuid === actor.xuid) return deny("You can't change your own role.");
  if (role === "owner" || target.role === "owner") return deny("Owners are set in the API's configuration.");
  const needed: Role = role === "admin" || target.role === "admin" ? "owner" : "admin";
  return atLeast(actor, needed) ? { ok: true } : deny("Only the owner manages admins.");
}

export interface ListingFields {
  slug: string;
  name: string;
  summary: string;
  description: string;
  version: string;
  source: string;
}

/** Normalises and validates listing fields, returning per-field messages for anything wrong. */
export function validateListing(input: unknown, reach: Reach): { fields: ListingFields; errors: Record<string, string> } {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const fields: ListingFields = {
    slug: text("slug"), name: text("name"), summary: text("summary"), description: text("description"),
    version: text("version"), source: text("source").replace(/\/$/, ""),
  };
  const errors: Record<string, string> = {};
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(fields.slug)) errors.slug = "Use 3–40 lowercase letters, numbers and dashes.";
  if (!fields.name || fields.name.length > 64) errors.name = "Name it in 64 characters or fewer.";
  if (fields.summary.length < 10 || fields.summary.length > 140) errors.summary = "Summarise it in 10–140 characters.";
  if (fields.description.length > 40000) errors.description = "Keep the description under 40,000 characters.";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(fields.version) || fields.version.length > 32) {
    errors.version = "Use a SemVer version such as 1.0.0.";
  }
  if (fields.source && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(fields.source)) {
    errors.source = "Link the GitHub repository, like https://github.com/you/mod.";
  }
  if (reach >= 3 && !fields.source) errors.source = "Mods that act for players or touch the network must link their source.";
  return { fields, errors };
}

/** Compares two grant requests and names what a new version adds and drops. */
export function grantDiff(previous: unknown, next: unknown) {
  const before = new Set(requestedCapabilities(previous));
  const after = requestedCapabilities(next);
  const oldCommands = new Set((previous as Grants | null)?.commands as string[] ?? []);
  const newCommands = new Set((next as Grants | null)?.commands as string[] ?? []);
  const commands = {
    added: [...newCommands].filter(name => !oldCommands.has(name)).sort(),
    removed: [...oldCommands].filter(name => !newCommands.has(name)).sort(),
  };
  const added = after.filter(name => !before.has(name));
  return {
    added,
    removed: [...before].filter((name) => !after.includes(name)),
    kept: after.filter((name) => before.has(name)),
    changed: before.has("commands") && after.includes("commands") && (commands.added.length || commands.removed.length) ? ["commands"] : [],
    commands, expanded: !!(added.length || commands.added.length),
  };
}
