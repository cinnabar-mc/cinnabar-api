import { encodeBase64Url } from "./identity";

/** Retains only salted account digests to count verified users across reconnects and restarts. */
export class UniqueUsers {
  constructor(private readonly sql: SqlStorage, private readonly salt: string) {
    sql.exec("CREATE TABLE IF NOT EXISTS unique_users (digest TEXT PRIMARY KEY)");
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

  /** Reads the durable total, including disconnected accounts and accounts with visibility disabled. */
  count(): number {
    return this.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM unique_users").one().total;
  }
}
