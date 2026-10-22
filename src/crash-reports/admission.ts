import type { Payload } from "./schema";

export const DAY_MS = 86_400_000;
const MAX_DAILY_IPS = 65_536;

export interface Budget {
  samples: number;
  bytes: number;
  groups: number;
}

/** Rejects invalid settings instead of silently removing an ingestion ceiling. Zero permits counting only. */
export function budget(env: Env): Budget | null {
  const raw = [env.CRASH_SAMPLES_PER_GROUP, env.CRASH_DAILY_MAX_BYTES, env.CRASH_DAILY_MAX_GROUPS];
  if (raw.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) return null;
  const values = raw.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  return { samples: values[0]!, bytes: values[1]!, groups: values[2]! };
}

/** Normalises grouping text while leaving the original consented payload available in sampled reports. */
export function signature(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 240);
}

/** Maps index dimensions to fixed sets so random device strings cannot multiply groups. */
export function dimensions(payload: Payload): { os: string; gpu: string; backend: string } {
  const os = payload.os.trim().toLowerCase();
  const gpu = payload.gpu?.trim().toLowerCase() ?? "";
  const backend = payload.backend?.trim().toLowerCase() ?? "";
  return {
    os: ["linux", "windows", "macos", "android", "ios"].includes(os) ? os : "other",
    gpu: ["nvidia", "amd", "intel", "apple", "qualcomm", "arm", "imagination"].find((name) =>
      gpu === name || gpu.startsWith(`${name} `)) ?? "other",
    backend: ["vulkan", "metal", "dx12", "dx11", "gl", "gles", "software"].includes(backend) ? backend : "other",
  };
}

/** Enforces 50 attempts per IP per UTC day with a daily salt and a bounded number of IP records. */
export async function admitIp(db: D1DatabaseSession, ip: string, day: number): Promise<boolean> {
  let daily = await db.prepare("SELECT salt FROM crash_days WHERE day = ?").bind(day).first<{ salt: string }>();
  if (!daily) {
    daily = await db.prepare(`INSERT INTO crash_days (day, salt) VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET salt = salt RETURNING salt`).bind(day, crypto.randomUUID()).first<{ salt: string }>();
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${daily!.salt}:${ip}`));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const row = await db.prepare(`INSERT INTO crash_ips (day, ip_hash, count)
    SELECT ?, ?, 1 WHERE (SELECT ips FROM crash_days WHERE day = ?) < ?
      OR EXISTS (SELECT 1 FROM crash_ips WHERE day = ? AND ip_hash = ?)
    ON CONFLICT(day, ip_hash) DO UPDATE SET count = count + 1 WHERE count < 50 RETURNING count`)
    .bind(day, key, day, MAX_DAILY_IPS, day, key).first();
  return !!row;
}

/** Atomically counts an admitted report and reserves at most the configured samples and bytes. */
export async function reserve(db: D1DatabaseSession, payload: Payload, hash: string, bytes: number, now: number, limits: Budget) {
  const day = Math.floor(now / DAY_MS);
  const normal = signature(payload.signature);
  const release = payload.release.replace(/^v/, "");
  const device = dimensions(payload);
  const results = await db.batch([
    db.prepare(`INSERT INTO crash_groups (day, signature, version, cursor_id, count, latest_at)
      SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM crash_reports WHERE id = ?)
        AND ((SELECT groups FROM crash_days WHERE day = ?) < ?
          OR EXISTS (SELECT 1 FROM crash_groups WHERE day = ? AND signature = ? AND version = ?))
      ON CONFLICT(day, signature, version) DO UPDATE SET count = count + 1, latest_at = MAX(latest_at, excluded.latest_at)
      RETURNING count`).bind(day, normal, release, crypto.randomUUID().replaceAll("-", ""), now,
        payload.report_id, day, limits.groups, day, normal, release),
    db.prepare(`INSERT OR IGNORE INTO crash_reports
      (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend, sample_day, payload_bytes)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM crash_groups
      WHERE day = ? AND signature = ? AND version = ? AND samples < ?
        AND (SELECT bytes FROM crash_days WHERE day = ?) <= ? - ?`)
      .bind(payload.report_id, payload.install_id, hash, now, normal, release, device.os, device.gpu, device.backend,
        day, bytes, day, normal, release, limits.samples, day, limits.bytes, bytes),
    db.prepare("SELECT install_id, payload_hash, received_at, stored FROM crash_reports WHERE id = ?").bind(payload.report_id),
  ]);
  return { counted: results[0]!.results.length > 0,
    row: results[2]!.results[0] as { install_id: string; payload_hash: string; received_at: number; stored: number } | undefined };
}
