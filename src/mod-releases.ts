import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../schema/v1.json";
import { compareVersions, type Channel } from "./protocol";

export interface ModRelease {
  manifest: {
    schema_version: 1;
    package: string;
    version: string;
    revision: string;
    host: { repository: string; revision: string; api_revision: string };
    artifact: { filename: string; size: number; sha256: string };
  };
  download_url: string;
}

export interface ModUpdateQuery {
  host_revision: string;
  api_revisions: string;
  current_version: string;
  current_revision: string;
}

/** Builds a validator from the published HTTP contract. */
function validator(name: string): Validator {
  const result = new Validator({ $ref: `${schema.$id}#/$defs/${name}` }, "2020-12");
  result.addSchema(schema as unknown as Schema);
  return result;
}

const releaseValidator = validator("ModRelease");
const queryValidator = validator("ModUpdateQuery");

/** Accepts an HTTPS download without embedded credentials or a fragment. */
function safeDownload(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** Checks publisher metadata before it can enter the persistent release catalogue. */
export function isModRelease(value: unknown): value is ModRelease {
  return value !== undefined && releaseValidator.validate(value).valid
    && safeDownload((value as ModRelease).download_url);
}

/** Restricts this publisher to configured packages and immutable assets in its own repository. */
export function publisherAllows(release: ModRelease, repository?: string, packageName?: string, hostRepository?: string): boolean {
  const m = release.manifest;
  return !!repository && m.package === packageName
    && !!hostRepository && m.host.repository === hostRepository
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && release.download_url === `https://github.com/${repository}/releases/download/v${m.version}/${m.artifact.filename}`;
}

/** Requires full native/mod identities and a bounded list of supported API revisions. */
export function isModUpdateQuery(value: unknown): value is ModUpdateQuery {
  return value !== undefined && queryValidator.validate(value).valid;
}

/** Removes unknown fields and orders fields so equivalent publication retries are identical. */
export function canonicalRelease(release: ModRelease): ModRelease {
  const { manifest: m } = release;
  return {
    manifest: {
      schema_version: 1, package: m.package, version: m.version, revision: m.revision,
      host: { repository: m.host.repository, revision: m.host.revision, api_revision: m.host.api_revision },
      artifact: { filename: m.artifact.filename, size: m.artifact.size, sha256: m.artifact.sha256 },
    },
    download_url: release.download_url,
  };
}

/** Retains immutable releases and indexes the stable mod API revisions each one supports. */
export class ModReleases {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS mod_releases (
      package TEXT NOT NULL, version TEXT NOT NULL, release TEXT NOT NULL,
      PRIMARY KEY (package, version)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mod_release_apis (
      package TEXT NOT NULL, repository TEXT NOT NULL, revision TEXT NOT NULL, version TEXT NOT NULL,
      PRIMARY KEY (package, repository, revision, version)
    )`);
    sql.exec("CREATE TABLE IF NOT EXISTS mod_release_assets (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS mod_releases_digest ON mod_releases (json_extract(release, '$.manifest.artifact.sha256'))");
    sql.exec(`CREATE TABLE IF NOT EXISTS released_mod_apis (
      channel TEXT NOT NULL, revision TEXT NOT NULL,
      PRIMARY KEY (channel, revision)
    )`);
    sql.exec("CREATE TABLE IF NOT EXISTS released_mod_api_channels (channel TEXT PRIMARY KEY)");
  }

  /** Stores an immutable version, accepts retries, and rejects changed metadata for that version. */
  publish(input: ModRelease): boolean {
    const release = canonicalRelease(input);
    const m = release.manifest;
    const encoded = JSON.stringify(release);
    const existing = this.sql.exec<{ release: string }>(
      "SELECT release FROM mod_releases WHERE package = ? AND version = ?", m.package, m.version,
    ).toArray()[0];
    if (existing) return existing.release === encoded;
    this.sql.exec("INSERT INTO mod_releases (package, version, release) VALUES (?, ?, ?)", m.package, m.version, encoded);
    const revision = m.host.api_revision;
    this.sql.exec("INSERT INTO mod_release_apis (package, repository, revision, version) VALUES (?, ?, ?, ?)",
      m.package, m.host.repository, revision, m.version);
    this.sql.exec("INSERT OR IGNORE INTO mod_release_assets (sha256, size) VALUES (?, ?)", m.artifact.sha256, m.artifact.size);
    return true;
  }

  /** Selects the highest compatible newer version from the legacy catalogue or an explicitly authorized union. */
  update(query: ModUpdateQuery & { package: string; host_repository: string }, candidates?: ModRelease[]): ModRelease | null {
    const revisions = query.api_revisions.split(",");
    const placeholders = revisions.map(() => "?").join(",");
    candidates ??= this.sql.exec<{ release: string }>(`SELECT r.release FROM mod_releases r
      JOIN mod_release_apis h ON h.package = r.package AND h.version = r.version
      WHERE h.package = ? AND h.repository = ? AND h.revision IN (${placeholders})`,
    query.package, query.host_repository, ...revisions).toArray().map(row => JSON.parse(row.release) as ModRelease);
    let best: ModRelease | null = null;
    for (const candidate of candidates) {
      const m = candidate.manifest;
      if (m.package !== query.package || m.host.repository !== query.host_repository
        || !revisions.includes(m.host.api_revision)) continue;
      if (m.revision === query.current_revision || compareVersions(m.version, query.current_version) <= 0) continue;
      if (!best || compareVersions(m.version, best.manifest.version) > 0) best = candidate;
    }
    return best;
  }

  /** Replaces the mod API revisions that the host build currently on this channel supports. */
  setReleasedApis(channel: string, revisions: readonly string[]): void {
    this.sql.exec("INSERT OR IGNORE INTO released_mod_api_channels (channel) VALUES (?)", channel);
    this.sql.exec("DELETE FROM released_mod_apis WHERE channel = ?", channel);
    for (const revision of new Set(revisions)) {
      this.sql.exec("INSERT INTO released_mod_apis (channel, revision) VALUES (?, ?)", channel, revision);
    }
  }

  /**
   * Selects the highest version for a first installation supported by the selected channel.
   * A channel that has never reported falls back to the union of all reported channels; until
   * any channel has reported, no revision is excluded. A selected channel's empty report excludes
   * all versions, even if other channels support them.
   */
  latest(packageName: string, hostRepository: string, channel: Channel = "beta", candidates?: ModRelease[]): ModRelease | null {
    const channelReported = this.sql.exec("SELECT 1 FROM released_mod_api_channels WHERE channel = ?", channel).toArray().length > 0;
    const reported = this.sql.exec("SELECT 1 FROM released_mod_api_channels LIMIT 1").toArray().length > 0;
    const rows = channelReported
      ? this.sql.exec<{ revision: string }>("SELECT revision FROM released_mod_apis WHERE channel = ?", channel)
      : this.sql.exec<{ revision: string }>("SELECT revision FROM released_mod_apis");
    const released = new Set(rows.toArray().map((row) => row.revision));
    candidates ??= this.sql.exec<{ release: string }>(
      "SELECT release FROM mod_releases WHERE package = ?", packageName,
    ).toArray().map(row => JSON.parse(row.release) as ModRelease);
    let best: ModRelease | null = null;
    for (const candidate of candidates) {
      if (candidate.manifest.package !== packageName || candidate.manifest.host.repository !== hostRepository) continue;
      if (reported && !released.has(candidate.manifest.host.api_revision)) continue;
      if (!best || compareVersions(candidate.manifest.version, best.manifest.version) > 0) best = candidate;
    }
    return best;
  }

  /** Authorizes public reads only after release publication committed successfully. */
  assetSize(hash: string): number | null {
    return this.sql.exec<{ size: number }>("SELECT size FROM mod_release_assets WHERE sha256 = ?", hash).toArray()[0]?.size ?? null;
  }

  /** Original legacy records, used to exclude marketplace-managed versions from fallback authorization. */
  all(hash?: string): ModRelease[] {
    const rows = hash === undefined ? this.sql.exec<{ release: string }>("SELECT release FROM mod_releases")
      : this.sql.exec<{ release: string }>("SELECT release FROM mod_releases WHERE json_extract(release, '$.manifest.artifact.sha256') = ?", hash);
    return rows.toArray().map(row => JSON.parse(row.release) as ModRelease);
  }

  /** Checks immutable legacy metadata before migrating the same version through the release hook. */
  matches(input: ModRelease): boolean {
    const row = this.sql.exec<{ release: string }>("SELECT release FROM mod_releases WHERE package = ? AND version = ?",
      input.manifest.package, input.manifest.version).toArray()[0];
    return !row || row.release === JSON.stringify(canonicalRelease(input));
  }
}
