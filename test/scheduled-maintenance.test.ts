import { createScheduledController, env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const maintenance = vi.hoisted(() => ({ recordOnlineCount: vi.fn(), recoverModPublications: vi.fn() }));
vi.mock("../src/routing", () => ({ hubFor: () => maintenance }));
beforeEach(() => {
  maintenance.recordOnlineCount.mockReset().mockResolvedValue(undefined);
  maintenance.recoverModPublications.mockReset().mockResolvedValue(undefined);
});

it("still recovers marketplace publications when the history cache fails", async () => {
  const failure = new Error("history storage unavailable");
  maintenance.recordOnlineCount.mockRejectedValue(failure);
  await expect(worker.scheduled(createScheduledController(), env)).rejects.toBe(failure);
  expect(maintenance.recoverModPublications).toHaveBeenCalledOnce();
});

it("still publishes presence history when marketplace recovery fails", async () => {
  const failure = new Error("marketplace unavailable");
  maintenance.recoverModPublications.mockRejectedValue(failure);
  await expect(worker.scheduled(createScheduledController(), env)).rejects.toBe(failure);
  expect(maintenance.recordOnlineCount).toHaveBeenCalledOnce();
});

it("waits for marketplace recovery before reporting a history failure", async () => {
  const failure = new Error("history storage unavailable");
  maintenance.recordOnlineCount.mockRejectedValue(failure);
  let finish!: () => void;
  const recovery = new Promise<void>(resolve => { finish = resolve; });
  maintenance.recoverModPublications.mockReturnValue(recovery);
  let settled = false;
  const outcome = worker.scheduled(createScheduledController(), env).catch(error => { settled = true; return error; });
  await Promise.resolve();
  expect(maintenance.recoverModPublications).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  finish();
  expect(await outcome).toBe(failure);
});
