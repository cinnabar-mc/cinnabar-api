export const LOGIN_REWARD_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export type LoginReward = { item_id: string; starts_at: number; ends_at: number };

/** Persists one login window per item until an explicit administrative stop and one claim per authenticated account. */
export class LoginRewards {
  private readonly rewards: Map<string, LoginReward>;

  constructor(private readonly storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS cosmetic_login_rewards (
      item_id TEXT PRIMARY KEY, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cosmetic_login_reward_claims (
      xuid TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (xuid, item_id)
    )`);
    this.rewards = new Map(sql.exec<LoginReward>("SELECT item_id, starts_at, ends_at FROM cosmetic_login_rewards")
      .toArray().map((reward) => [reward.item_id, reward]));
  }

  /** Starts a seven-day window once; retries, redeploys and expired windows retain their original dates. */
  start(itemId: string, now: number): LoginReward {
    let reward = this.rewards.get(itemId);
    if (!reward) {
      reward = this.storage.sql.exec<LoginReward>(`INSERT INTO cosmetic_login_rewards (item_id, starts_at, ends_at)
        VALUES (?, ?, ?) RETURNING item_id, starts_at, ends_at`, itemId, now, now + LOGIN_REWARD_DURATION_MS).one();
      this.rewards.set(itemId, reward);
    }
    return { ...reward };
  }

  /** Stops future claims and removes this item's claims and ownership atomically; a later start opens a fresh window. */
  stop(itemId: string): string[] {
    const revoked = this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM cosmetic_login_rewards WHERE item_id = ?", itemId);
      this.storage.sql.exec("DELETE FROM cosmetic_login_reward_claims WHERE item_id = ?", itemId);
      return this.storage.sql.exec<{ xuid: string }>(
        "DELETE FROM cosmetic_entitlements WHERE item_id = ? RETURNING xuid", itemId,
      ).toArray().map((row) => row.xuid);
    });
    this.rewards.delete(itemId);
    return revoked;
  }

  /** Claims eligible items within the caller's transaction; claimed items never bypass a later manual revocation. */
  claim(xuid: string, now: number): boolean {
    let changed = false;
    for (const reward of this.rewards.values()) {
      if (now < reward.starts_at || now >= reward.ends_at) continue;
      const claimed = this.storage.sql.exec<{ item_id: string }>(`INSERT OR IGNORE INTO cosmetic_login_reward_claims (xuid, item_id)
        VALUES (?, ?) RETURNING item_id`, xuid, reward.item_id).toArray();
      if (!claimed.length) continue;
      this.storage.sql.exec("INSERT OR IGNORE INTO cosmetic_entitlements (xuid, item_id) VALUES (?, ?)", xuid, reward.item_id);
      changed = true;
    }
    return changed;
  }
}
