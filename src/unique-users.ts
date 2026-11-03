import { encodeBase64Url } from "./identity";

/** Retains only salted account digests to count verified users across reconnects and restarts. */
export class UniqueUsers {
  constructor(private readonly sql: SqlStorage, private readonly salt: string) {
    sql.exec("CREATE TABLE IF NOT EXISTS unique_users (digest TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS unique_user_total (id INTEGER PRIMARY KEY CHECK (id = 1), total INTEGER NOT NULL)");
    // Counts existing digests once; the triggers then keep the stored total in step with every insert and delete.
    if (sql.exec("SELECT 1 FROM unique_user_total WHERE id = 1").toArray().length === 0) {
      sql.exec("INSERT INTO unique_user_total (id, total) SELECT 1, COUNT(*) FROM unique_users");
    }
    sql.exec(`CREATE TRIGGER IF NOT EXISTS unique_users_added AFTER INSERT ON unique_users
      BEGIN UPDATE unique_user_total SET total = total + 1 WHERE id = 1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS unique_users_removed AFTER DELETE ON unique_users
      BEGIN UPDATE unique_user_total SET total = total - 1 WHERE id = 1; END`);
  }

  /** Derives a service-local account key without persisting the XUID or display name. */
  async digest(xuid: string): Promise<string> {
    const bytes = new TextEncoder().encode(`unique-user:${this.salt}:${xuid}`);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  }

  /** Records an admitted, authenticated account once; duplicate inserts leave the total unchanged. */
  record(digest: string): void {
    this.sql.exec("INSERT OR IGNORE INTO unique_users (digest) VALUES (?)", digest);
  }

  /** Reads the stored total, including disconnected accounts and accounts with visibility disabled, without scanning digests. */
  count(): number {
    return this.sql.exec<{ total: number }>("SELECT total FROM unique_user_total WHERE id = 1").one().total;
  }
}
