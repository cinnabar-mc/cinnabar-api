import { catalogResponse, assetResponse, revalidateCatalog } from "./cosmetics";
import { authorizePublisher, entitlementCommand, loginRewardCommand } from "./cosmetics-admin";
import { Hono } from "hono";
import { publicCache } from "./public-cache";
import { count } from "./metrics";
import { isModRelease, isModUpdateQuery, publisherAllows } from "./mod-releases";
import { isReleaseHookRequest } from "./protocol";
import { hubFor } from "./routing";
import { DEFAULT_HISTORY_RANGE, HISTORY_RANGES, loadHistory, snapshotHistory, type HistoryRange } from "./history-snapshot";

export { Hub } from "./hub";

const MAX_HOOK_BODY_BYTES = 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", publicCache("public, max-age=60"),
  (c) => c.json({ ok: true, api: "v1" }));

app.get("/v1/presence/count", publicCache("public, max-age=30"), async (c) => {
  const online = await hubFor(c.env).onlineCount();
  return c.json({ online }, 200, {
    "Access-Control-Allow-Origin": "*",
  });
});

app.get("/v1/users/count", publicCache("public, max-age=60"), async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  try {
    return c.json({ unique: await hubFor(c.env).uniqueUserCount() });
  } catch {
    return c.json({ error: "user count unavailable" }, 503, { "Retry-After": "60" });
  }
});

app.get("/v1/presence/players", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.PRESENCE_READ_SECRET))) return c.body(null, 401);
  return c.json({ names: await hubFor(c.env).onlineNames() });
});

app.get("/v1/cosmetics/catalog", revalidateCatalog,
  publicCache("public, max-age=300"),
  (c) => catalogResponse(c.env.COSMETIC_ASSETS));

app.get("/v1/presence/history", publicCache("public, max-age=60", { range: DEFAULT_HISTORY_RANGE }), async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  const range = c.req.query("range") ?? DEFAULT_HISTORY_RANGE;
  if (!Object.hasOwn(HISTORY_RANGES, range)) return c.json({ error: "unsupported range" }, 400);
  try {
    return c.json(snapshotHistory(await loadHistory(c.env.API_CACHE), range as HistoryRange, Date.now()));
  } catch {
    return c.json({ error: "history unavailable" }, 503, { "Retry-After": "60" });
  }
});
app.get("/v1/cosmetics/assets/:hash",
  publicCache("public, max-age=31536000, immutable"),
  (c) => assetResponse(c.req.param("hash"), c.env.COSMETIC_ASSETS));

app.post("/v1/cosmetics/entitlements", async (c) => {
  if (!(await authorizePublisher(c.req.header("Authorization"), c.env))) return c.body(null, 401);
  const text = await readBounded(c.req.raw.body, 40_000);
  if (text === null) return c.body(null, 400);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return c.body(null, 400); }
  const command = entitlementCommand(value);
  if (!command) return c.body(null, 400);
  const result = await hubFor(c.env).setCosmeticEntitlements(command.xuid, command.item_ids, command.owned);
  return result === null ? c.body(null, 400) : c.json({ owned_cosmetics: result });
});

app.post("/v1/cosmetics/login-rewards", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!(await authorizePublisher(c.req.header("Authorization"), c.env))) return c.body(null, 401);
  const text = await readBounded(c.req.raw.body, 1024);
  if (text === null) return c.body(null, 400);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return c.body(null, 400); }
  const command = loginRewardCommand(value);
  if (!command) return c.body(null, 400);
  const reward = await hubFor(c.env).startLoginReward(command.item_id);
  return reward === null ? c.body(null, 400) : c.json({
    item_id: reward.item_id,
    starts_at: new Date(reward.starts_at).toISOString(),
    ends_at: new Date(reward.ends_at).toISOString(),
  });
});

app.delete("/v1/cosmetics/login-rewards", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!(await authorizePublisher(c.req.header("Authorization"), c.env))) return c.body(null, 401);
  const text = await readBounded(c.req.raw.body, 1024);
  if (text === null) return c.body(null, 400);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return c.body(null, 400); }
  const command = loginRewardCommand(value);
  if (!command) return c.body(null, 400);
  const result = await hubFor(c.env).stopLoginReward(command.item_id);
  return result === null ? c.body(null, 400) : c.json(result);
});

app.post("/v1/mods/releases", async (c) => {
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.MOD_RELEASE_HOOK_SECRET))) return c.body(null, 401);
  const limit = 16 * 1024;
  if (!(Number(c.req.header("Content-Length") ?? 0) <= limit)) return c.body(null, 400);
  const text = await readBounded(c.req.raw.body, limit);
  if (text === null) return c.body(null, 400);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return c.body(null, 400); }
  if (!isModRelease(body)) return c.body(null, 400);
  if (!publisherAllows(body, c.env.MOD_RELEASE_REPOSITORY, c.env.MOD_RELEASE_PACKAGES)) return c.body(null, 403);
  return c.body(null, await hubFor(c.env).publishModRelease(body) ? 204 : 409);
});

app.get("/v1/mods/:package/update", async (c) => {
  c.header("Cache-Control", "no-store");
  const query = { ...c.req.query(), package: c.req.param("package") };
  if (!isModUpdateQuery(query)) return c.body(null, 400);
  const release = await hubFor(c.env).modUpdate(query);
  return release ? c.json(release) : c.body(null, 204);
});

app.post("/v1/releases", async (c) => {
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.RELEASE_HOOK_SECRET))) return c.body(null, 401);
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (!(declared <= MAX_HOOK_BODY_BYTES)) return c.body(null, 400);
  const text = await readBounded(c.req.raw.body, MAX_HOOK_BODY_BYTES);
  if (text === null) return c.body(null, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.body(null, 400);
  }
  if (!isReleaseHookRequest(body)) return c.body(null, 400);
  await hubFor(c.env).recordRelease(body.channel, body.version, body.build);
  return c.body(null, 204);
});

app.get("/v1/connect", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426, { Upgrade: "websocket" });
  return hubFor(c.env).fetch(c.req.raw);
});

/** Reads the body as UTF-8, or returns null (cancelling the stream) once it passes `max` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Compares the bearer token with the secret in constant time via fixed-length digests; false when the secret is unset. */
async function bearerMatches(header: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export default {
  fetch: app.fetch,
  /** Samples at execution time, so delayed cron delivery cannot fabricate past counts. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try { await hubFor(env).recordOnlineCount(); }
    catch (error) { count(env.METRICS, "history_publish_failed"); throw error; }
  },
} satisfies ExportedHandler<Env>;
