import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../schema/v1.json";
import { compareVersions } from "./protocol";

export interface ModRelease {
  manifest: {
    schema_version: 1;
    package: string;
    version: string;
    revision: string;
    host: { repository: string; supported_revisions: string[] };
    artifact: { filename: string; size: number; sha256: string };
  };
  download_url: string;
}

export interface ModUpdateQuery {
  package: string;
  host_repository: string;
  host_revision: string;
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
export function publisherAllows(release: ModRelease, repository?: string, packages?: string): boolean {
  const m = release.manifest;
  return !!repository && !!packages?.split(",").includes(m.package)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && release.download_url === `https://github.com/${repository}/releases/download/v${m.version}/${m.artifact.filename}`;
}

/** Requires exact full host and installed mod revisions; unknown identities never mean latest. */
export function isModUpdateQuery(value: unknown): value is ModUpdateQuery {
  return value !== undefined && queryValidator.validate(value).valid;
}

/** Removes unknown fields and orders revisions so equivalent publication retries are identical. */
function canonicalRelease(release: ModRelease): ModRelease {
  const { manifest: m } = release;
  return {
    manifest: {
      schema_version: 1, package: m.package, version: m.version, revision: m.revision,
      host: { repository: m.host.repository, supported_revisions: [...m.host.supported_revisions].sort() },
      artifact: { filename: m.artifact.filename, size: m.artifact.size, sha256: m.artifact.sha256 },
    },
    download_url: release.download_url,
  };
}

/** Retains immutable releases and indexes the exact host commits each one supports. */
export class ModReleases {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS mod_releases (
      package TEXT NOT NULL, version TEXT NOT NULL, release TEXT NOT NULL,
      PRIMARY KEY (package, version)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mod_release_hosts (
      package TEXT NOT NULL, repository TEXT NOT NULL, revision TEXT NOT NULL, version TEXT NOT NULL,
      PRIMARY KEY (package, repository, revision, version)
    )`);
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
    for (const revision of m.host.supported_revisions) {
      this.sql.exec("INSERT INTO mod_release_hosts (package, repository, revision, version) VALUES (?, ?, ?, ?)",
        m.package, m.host.repository, revision, m.version);
    }
    return true;
  }

  /** Selects the highest newer stable version supporting this exact host, without a fallback. */
  update(query: ModUpdateQuery): ModRelease | null {
    const rows = this.sql.exec<{ release: string }>(`SELECT r.release FROM mod_releases r
      JOIN mod_release_hosts h ON h.package = r.package AND h.version = r.version
      WHERE h.package = ? AND h.repository = ? AND h.revision = ?`,
    query.package, query.host_repository, query.host_revision);
    let best: ModRelease | null = null;
    for (const row of rows) {
      const candidate = JSON.parse(row.release) as ModRelease;
      const m = candidate.manifest;
      if (m.revision === query.current_revision || compareVersions(m.version, query.current_version) <= 0) continue;
      if (!best || compareVersions(m.version, best.manifest.version) > 0) best = candidate;
    }
    return best;
  }
}
