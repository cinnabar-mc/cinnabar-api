import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("preserves existing crash reservations and conservatively reserves their daily budgets", async () => {
  const fixture = env as Env & CrashBindings & { TEST_CRASH_MIGRATIONS: { name: string; queries: string[] }[] };
  const migrations = fixture.TEST_CRASH_MIGRATIONS;
  const db = fixture.CRASH_INDEX;
  await applyD1Migrations(db, migrations.slice(0, 1));
  await db.batch([0, 1].map((index) => db.prepare(`INSERT INTO crash_reports
    (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend, stored)
    VALUES (?, 'install', 'hash', 86400000, 'panic: boom', '1.2.3', 'linux', 'gpu', 'vulkan', ?)`)
    .bind(String(index), index)));
  await applyD1Migrations(db, migrations);
  expect(await db.prepare("SELECT day, count, samples FROM crash_groups").first()).toEqual({ day: 1, count: 2, samples: 2 });
  expect(await db.prepare("SELECT day, groups, bytes FROM crash_days").first())
    .toEqual({ day: 1, groups: 1, bytes: 2 * 524288 });
  expect(await db.prepare("SELECT COUNT(*) FROM crash_reports").first("COUNT(*)")).toBe(2);
});
