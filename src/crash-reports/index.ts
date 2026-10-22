import { readPayload } from "./body";
import { RETENTION_MS, validPayload } from "./schema";

const PAGE_SIZE = 100;
// Empty objects fence conditional uploads after payload retention removes their index rows.
const EXPIRED_METADATA = { expired: "1" };

/** Uses a fixed key for a report id so a lost acknowledgement cannot create another object. */
function objectKey(id: string): string { return `reports/${id}.json`; }

/** True only after every crash storage and rate-limit binding has been configured. */
function configured(env: Env): env is Env & CrashBindings {
  return !!(env.CRASH_REPORTS && env.CRASH_INDEX && env.CRASH_IP_LIMIT && env.CRASH_INSTALL_LIMIT);
}

/** Accepts one consented client payload without invoking a Durable Object. */
export async function receive(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (!configured(env)) return new Response(null, { status: 503 });
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.CRASH_IP_LIMIT.limit({ key: ip })).success) return limited();
  const decoded = await readPayload(request);
  if (typeof decoded === "number") return new Response(null, { status: decoded });
  if (!validPayload(decoded.value)) return new Response(null, { status: 422 });
  const payload = decoded.value;
  if (!(await env.CRASH_INSTALL_LIMIT.limit({ key: payload.install_id })).success) return limited();
  const digest = await crypto.subtle.digest("SHA-256", decoded.json);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const db = env.CRASH_INDEX;
  // Reserve first. A failed R2 write leaves a pending row that the same report can complete.
  await db.prepare(`INSERT OR IGNORE INTO crash_reports
    (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(payload.report_id, payload.install_id, hash, now, payload.signature,
      payload.release, payload.os, payload.gpu ?? "", payload.backend ?? "").run();
  const lookup = db.prepare("SELECT install_id, payload_hash, received_at, stored FROM crash_reports WHERE id = ?").bind(payload.report_id);
  const row = await lookup.first<{ install_id: string; payload_hash: string; received_at: number; stored: number }>();
  if (row?.install_id !== payload.install_id || row.payload_hash !== hash) return new Response(null, { status: 422 });
  // Retention may already be deleting this reservation. An expired retry cannot revive its object.
  if (row.received_at <= now - RETENTION_MS) return new Response(null, { status: 422 });
  if (row.stored) return new Response(null, { status: 200 });
  const object = await env.CRASH_REPORTS.put(objectKey(payload.report_id), decoded.json, {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: hash },
  });
  if (!object) {
    const previous = await env.CRASH_REPORTS.head(objectKey(payload.report_id));
    if (previous?.customMetadata?.expired === EXPIRED_METADATA.expired) {
      await db.prepare("DELETE FROM crash_reports WHERE id = ? AND stored = 0 AND install_id = ? AND payload_hash = ?")
        .bind(payload.report_id, payload.install_id, hash).run();
      return new Response(null, { status: 422 });
    }
    if (previous?.customMetadata?.sha256 !== hash) throw new Error("inconsistent crash object reservation");
  }
  const confirmed = await db.prepare(`UPDATE crash_reports SET stored = 1
    WHERE id = ? AND stored = 0 AND received_at = ? AND install_id = ? AND payload_hash = ?`)
    .bind(payload.report_id, row.received_at, payload.install_id, hash).run();
  if (!confirmed.meta.changes) {
    const latest = await lookup.first<NonNullable<typeof row>>();
    if (latest?.stored && latest.received_at === row.received_at
      && latest.install_id === payload.install_id && latest.payload_hash === hash
      && latest.received_at > now - RETENTION_MS) return new Response(null, { status: 200 });
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 201 });
}

/** Signals a temporary refusal and lets the sender respect its persisted backoff. */
function limited(): Response { return new Response(null, { status: 429, headers: { "Retry-After": "60" } }); }

/** Lists groups or reports only after the caller has authenticated the owner bearer token. */
export async function listing(url: URL, env: Env): Promise<Response> {
  if (!configured(env)) return new Response(null, { status: 503 });
  const cutoff = Date.now() - RETENTION_MS;
  const cursor = url.searchParams.get("cursor");
  const match = cursor?.match(/^([0-9]+):([0-9a-f]{32})$/);
  if (cursor && !match) return new Response(null, { status: 400 });
  const before = match ? Number(match[1]) : Date.now() + 1;
  const beforeId = match?.[2] ?? "z";
  if (!Number.isSafeInteger(before)) return new Response(null, { status: 400 });
  if (url.searchParams.get("groups") === "1") {
    const rows = await env.CRASH_INDEX.prepare(`SELECT signature, version, os, gpu, backend,
      COUNT(*) AS count, MAX(received_at) AS latest_at, MIN(id) AS cursor_id FROM crash_reports
      WHERE stored = 1 AND received_at > ? GROUP BY signature, version, os, gpu, backend
      HAVING latest_at < ? OR (latest_at = ? AND cursor_id < ?)
      ORDER BY latest_at DESC, cursor_id DESC LIMIT ?`).bind(cutoff, before, before, beforeId, PAGE_SIZE)
      .all<{ latest_at: number; cursor_id: string }>();
    const last = rows.results.at(-1);
    const next = rows.results.length === PAGE_SIZE && last ? `${last.latest_at}:${last.cursor_id}` : null;
    const groups = rows.results.map(({ cursor_id, ...group }) => group);
    return Response.json({ groups, next_cursor: next }, { headers: { "Cache-Control": "no-store" } });
  }
  const rows = await env.CRASH_INDEX.prepare(`SELECT id, received_at, signature, version, os, gpu, backend
    FROM crash_reports WHERE stored = 1 AND received_at > ?
    AND (received_at < ? OR (received_at = ? AND id < ?))
    ORDER BY received_at DESC, id DESC LIMIT ?`).bind(cutoff, before, before, beforeId, PAGE_SIZE)
    .all<{ id: string; received_at: number }>();
  const last = rows.results.at(-1);
  const next = rows.results.length === PAGE_SIZE && last ? `${last.received_at}:${last.id}` : null;
  return Response.json({ reports: rows.results, next_cursor: next }, { headers: { "Cache-Control": "no-store" } });
}

/** Reads one retained report after owner authentication; raw IP addresses are never stored. */
export async function report(id: string, env: Env): Promise<Response> {
  if (!configured(env)) return new Response(null, { status: 503 });
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response(null, { status: 404 });
  const row = await env.CRASH_INDEX.prepare("SELECT received_at FROM crash_reports WHERE id = ? AND stored = 1")
    .bind(id).first<{ received_at: number }>();
  if (!row || row.received_at <= Date.now() - RETENTION_MS) return new Response(null, { status: 404 });
  const object = await env.CRASH_REPORTS.get(objectKey(id));
  if (!object || object.customMetadata?.expired === EXPIRED_METADATA.expired) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** Replaces one bounded batch of expired payloads with empty markers before removing index rows.
 * Run hourly; pending reservations are also removed. Repeating a failed batch is safe. */
export async function expire(env: Env, now = Date.now()): Promise<number> {
  if (!configured(env)) return 0;
  const rows = await env.CRASH_INDEX.prepare("SELECT id FROM crash_reports WHERE received_at <= ? ORDER BY received_at LIMIT 100")
    .bind(now - RETENTION_MS).all<{ id: string }>();
  if (!rows.results.length) return 0;
  const ids = rows.results.map((row) => row.id);
  // A delayed conditional put cannot recreate a payload after this overwrite. R2 lifecycle
  // removes the empty markers later; they contain no report fields or installation identity.
  const reports = env.CRASH_REPORTS;
  await Promise.all(ids.map((id) => reports.put(objectKey(id), "", { customMetadata: EXPIRED_METADATA })));
  await env.CRASH_INDEX.prepare(`DELETE FROM crash_reports WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).run();
  return ids.length;
}
