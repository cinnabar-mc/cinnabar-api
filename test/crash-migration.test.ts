import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("preserves reservations and backfills sampled and counting-only daily budgets", async () => {
  const fixture = env as Env & CrashBindings & { TEST_CRASH_MIGRATIONS: { name: string; queries: string[] }[] };
  const migrations = fixture.TEST_CRASH_MIGRATIONS;
  const db = fixture.CRASH_INDEX;
  await applyD1Migrations(db, migrations.slice(0, 1));
  await db.batch([0, 1].map((index) => db.prepare(`INSERT INTO crash_reports
    (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend, stored)
    VALUES (?, 'install', 'hash', 86400000, 'panic: boom', '1.2.3', 'linux', 'gpu', 'vulkan', ?)`)
    .bind(String(index), index)));
  await applyD1Migrations(db, migrations.slice(0, 2));
  expect(await db.prepare("SELECT day, count, samples FROM crash_groups").first()).toEqual({ day: 1, count: 2, samples: 2 });
  expect(await db.prepare("SELECT day, groups, bytes FROM crash_days").first())
    .toEqual({ day: 1, groups: 1, bytes: 2 * 524288 });
  expect(await db.prepare("SELECT COUNT(*) FROM crash_reports").first("COUNT(*)")).toBe(2);
  await db.prepare("INSERT INTO crash_days (day, salt) VALUES (2, 'fixture')").run();
  await db.prepare(`INSERT INTO crash_groups (day, signature, version, cursor_id, count, latest_at, samples)
    VALUES (1, 'counting only', '1.2.3', 'second', 25, 86400000, 0)`).run();
  await applyD1Migrations(db, migrations);
  expect((await db.prepare("SELECT reports FROM crash_days ORDER BY day").all()).results)
    .toEqual([{ reports: 27 }, { reports: 0 }]);
});
