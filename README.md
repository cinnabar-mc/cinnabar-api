# cinnabar-api

The [Cinnabar](https://github.com/cinnabar-mc/cinnabar) client's API: release notifications and player presence, as a Cloudflare Worker
(Hono) with one Durable Object. [`schema/v1.json`](schema/v1.json) is the machine-readable
contract (JSON Schema for every HTTP body and WebSocket message); the server validates inbound
messages against it.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/downloads/count` | Public `{"downloads":0}` total of installer and update-package downloads from GitHub client releases. Allows cross-origin reads. |
| `GET /v1/health` | `{"ok":true,"api":"v1"}` |
| `GET /v1/presence/count` | Public `{"online":0}` count of unique connected, authenticated accounts with visibility on. Allows cross-origin reads and caching for 30 seconds. No identifiers or retained offline presence. |
| `GET /v1/users/count` | Public `{"unique":0}` total of verified accounts since tracking was deployed. Deduplicates reconnects and devices, includes visibility-off accounts, and persists after disconnects and restarts. Allows cross-origin reads and caching for 60 seconds; no historical backfill. |
| `GET /v1/presence/players` | Private `{"names":[]}` list of verified names for those same online accounts. Requires a bearer token matching the `PRESENCE_READ_SECRET` Worker secret; never cached or exposed through CORS. |
| `GET /v1/presence/history?range=24h` | Public anonymous player-count history. Ranges: `24h` (one minute), `7d` (ten minutes), `30d` (one hour). Allows cross-origin reads and caching for 60 seconds. |
| `POST /v1/releases` | Release hook. `Authorization: Bearer <RELEASE_HOOK_SECRET>`, body `{"channel","version","build"}`; records and broadcasts only a newer (version, build) pair. Repeats and older records are no-ops. Omitted v1 builds mean zero. |
| `POST /v1/mod/releases` | Requires a dedicated `MOD_RELEASE_HOOK_SECRET` bearer credential; the native release-hook credential is rejected. Publishes `{manifest, download_url}` for an immutable stable mod version. Identical retries return 204; changed metadata for that package/version returns 409. |
| `PUT /v1/mod/assets/:sha256` | Dedicated mod-publisher bearer credential required. Verifies the component header, SHA-256 and 32 MiB limit before storing it under its content hash. Uploading alone does not publish it. |
| `GET /v1/mod/assets/:sha256` | Anonymous immutable WASM download, available only after metadata publication. Never exposes the private source repository or an upload credential. |
| `GET /v1/mod/download` | Anonymous first-install download of the newest published stable mod for the configured package and host repository. No hash or installed version required. Streams the verified WASM with its download filename; returns 404 if unavailable. Responses are not cached. Older hosts should use the compatibility-aware update route. |
| `GET /v1/mod/update` | Requires full `host_revision` and comma-separated supported `api_revisions`, installed `current_version` and full `current_revision`; the official package and host repository are fixed server-side. Returns 200 with the newest newer compatible stable release or 204 with no body. Invalid or missing identities return 400. Responses are not cached. |
| `GET /v1/connect` | WebSocket. The client authenticates with a Minecraft multiplayer token plus an ES384 proof of its key, then can toggle visibility, look up which XUIDs or UUIDs recently used Cinnabar, and receives release pushes. |

Public GET responses use the Cloudflare Cache API with lifetimes declared beside each route:

| Route | Cache lifetime |
| --- | --- |
| `/v1/health` | 60 seconds |
| `/v1/downloads/count` | 300 seconds |
| `/v1/presence/count` | 30 seconds |
| `/v1/users/count` | 60 seconds |
| `/v1/presence/history` | 60 seconds per supported range |
| `/v1/cosmetics/catalog` | 300 seconds, with `If-None-Match` revalidation on cache hits and misses |
| `/v1/cosmetics/assets/:hash` | One year, immutable |

The cache is local to each Cloudflare location. Public routes ignore unrelated query parameters and
reuse the same anonymous response when an Authorization header is present. Private routes, writes
and WebSocket connections never use this cache. Unknown asset digests have a ten-second negative
cache; missing files for known assets and other errors are not cached.

Close codes: `4401` failed or timed-out authentication, `1009` frame over 16 KiB, `1007` frame
that isn't a JSON object with a `type`, `1008` invalid messages, binary frames, flood control or
repeated lookup rate limiting, and `1011` issuer unreachable. `4429` means stay away: its reason
is `retry_after=<seconds>`. Clients wait at least that long plus jitter before reconnecting,
and honour HTTP 429 `Retry-After` on dial. Unknown fields are ignored; unknown message types
are ignored after authentication. During the handshake only the expected message is accepted.
The text frame `ping` gets `pong` without waking the Hub.
Authenticated sockets expire after three missed heartbeat intervals (90 seconds by default). The
online count excludes expired sessions even before their sockets close; alarm maintenance closes
them with `1001`. Automatic heartbeat timestamps survive hibernation.
Reconnects reclaim expired account slots before the per-account connection limit is checked.
The public online count retains its 30-second cache.
Deploying verified-name retention closes older authenticated sockets once with `1012`
so reconnecting clients supply their signed identity again.

- Connections: at most 20,000 per Hub, including closing sockets; at most 8 pending handshakes
  per IPv4 address or IPv6 /64, and at most 4 ready sockets per XUID. Ready sockets do not count
  toward the IP cap. Excess upgrades receive HTTP 429 with `Retry-After: 10`; excess account
  sockets close with `4429` and `retry_after=10`.
- Flood control: at most 30 non-ping frames and 64 KiB of text in each 10-second socket window,
  including hello and proof. After 3 refused lookups, the socket closes with `1008`.
- Lookups: optional `xuids` and `uuids` arrays hold at most 128 identifiers combined; an empty
  lookup gets an empty result. UUIDs use lowercase hyphenated form. Batches
  share an account bucket of 1,024 tokens, refilling 512 per minute. Each unique requested
  identifier in each array costs one token, including negative answers.
  Reconnecting or opening another socket does not reset the bucket.
  Results contain `cinnabar` XUID matches and, when UUIDs were requested, `cinnabar_uuids` UUID
  matches. Each result array contains only identifiers from its corresponding request array.
- Welcome advertises `lookup_batch_max`, `lookup_bucket_capacity`, `lookup_refill_per_min`,
  `cache_ttl_ms` (120,000), `ping_interval_ms` (30,000), and `reconnect_max_ms` (300,000).
  These fields and `hello.client_build` are optional in v1. Catch-up compares version, then build.
  Release messages are hints; clients still verify the signed update manifest.
- Issuer keys: cached for an hour, with at most one refresh attempt per 60 s, including unknown `kid`s
  and failures. Sessions remain authenticated after the original token expires.

## Privacy

- Unique-user tracking retains one salted account digest per successfully authenticated and admitted
  account, indefinitely, separately from online presence. It stores no display names, raw XUIDs,
  activity timestamps or IP addresses. Visibility controls presence; it does not opt out of this
  aggregate. Only the total is public. Existing sessions count on their next successful login;
  accounts that have not authenticated since deployment cannot be inferred from past online samples.
Mod release metadata is public and retained across deployments. The schema version 1
manifest declares `package`, stable `version`, mod source `revision`,
`host: {repository, revision, api_revision}`, and `artifact: {filename, size, sha256}`.
The hook also supplies an HTTPS `download_url` without embedded credentials. The API
does not fetch the publisher's URL or execute the artifact. The hook body is bounded
to 16 KiB; manifests describe one stable mod API generation and at most a 32 MiB artifact.
Only stable mod versions are currently supported; prereleases are rejected.

Selection matches the server-configured host repository and the native build's supported
mod API compatibility revisions, then numeric semantic version precedence. The native
build's source commit is required but does not have to equal the mod's build pin.
New native commits retaining support for the mod's API revision receive compatible
updates without a build-pin change. Unsupported API revisions receive no update. The manifest records both
the native commit used for the mod build and its stable API generation.

The host lists supported API revisions. Unrelated releases keep the same list; new
capabilities append a revision while retaining older entries; breaking changes remove
revisions that are no longer supported. A mod using a new capability requires its new
API revision, so older hosts keep their last compatible release.
No Git ancestry or commit ordering is assumed. Selection never repeats the installed
mod revision or downgrades the installed version. The native updater must verify the
selected API revision is supported, identity, size and digest before atomic installation.

Deploy this API support before configuring publishers to call the hook. A publisher
must upload its release artifact before registering the matching metadata. Changing
bytes or compatibility metadata requires a new package version. Keep downloads for
previously published versions available. Configure publisher credentials through its
secret store, using the same value as this Worker's `MOD_RELEASE_HOOK_SECRET`.
The configured `MOD_RELEASE_REPOSITORY` and `MOD_RELEASE_PACKAGE`
restrict that credential to its repository and package and immutable versioned GitHub
asset URLs. Deployments install the dedicated secret from the protected production
environment; missing secrets disable publication. The publishing repository should
keep its matching credential in a release environment restricted to release refs.

- The public online count includes each visible connected account once, even with several sockets.
  Visibility off excludes that socket; an account counts while any of its fresh open sockets is visible.
- Lookups answer “uses Cinnabar,” rather than providing an exact online status. Visible accounts
  linger in Hub memory for `PRESENCE_LINGER_MS` (30 minutes) after their last socket closes.
  Visibility off clears retained presence immediately; another visible socket can still make
  the account visible. Linger is best effort and is lost when the Hub hibernates or restarts.
- Presence UUIDs are derived from the verified XUID, never supplied by the client at login.
- Connection attachments survive hibernation and hold the XUID, UUID, visibility, channel, and socket
  flood counters and latest client-message time. Handshakes (at most 10 s) temporarily hold the
  nonce, public key, client version and build. Verified display names stay with active
  connection attachments for administrative queries; tokens are never stored. Neither
  display names nor tokens are sent in welcome.
- Account lookup budgets survive reconnects and hibernation in Durable Object storage. Each
  record holds only an XUID, remaining token count and refill timestamp; an alarm removes records
  unused for five minutes. Requested rosters and lookup results are not retained.
- Durable storage also holds release records (channel, version, build, published_at) and a random
  admission-hash salt. Pending handshake attachments contain a salted hash of their IPv4 address
  or IPv6 /64, removed on authentication or close. In-memory counters rebuild from these hashes
  on wake. Raw IP addresses are used only to compute the hash during admission.
- Server addresses are not sent, but submitted roster XUIDs can reveal who shares a server.
  Player data is not logged. Analytics Engine receives only fixed event labels and counts for
  admission refusals, authentication failures, overload closes, lookups, history storage work,
  publication failures and cache failures, with no identifiers
  or payloads. Counts are aggregated per invocation; failed metric writes are dropped without
  affecting admission or cleanup. Workers observability remains off so invocation logs do not
  record request metadata.

## Shared emotes

Authenticated clients send `emote_state` with a clip identifier (or `null` to stop), elapsed
playback time, and up to 128 nearby XUIDs/UUIDs combined. Phase refreshes can omit both
identifier arrays to retain existing watches; an explicit empty array clears them. The hub forwards `emote` updates only
when both clients report each other nearby. It derives sender identities from authentication;
clients cannot supply another account's identity. Clients ignore unknown clip identifiers.

The existing visibility option controls publishing. Stops, visibility opt-out, disconnects and
removed peers withdraw playback. Active updates carry a remaining lease of at most 15 seconds;
clients renew at five-second intervals and expire silence locally. Newly subscribed clients
receive only a still-live dance. Socket attachments retain watches and phases across hibernation;
no emote history is written to durable storage or logs. No server addresses are sent.

## Development

```sh
pnpm install
pnpm test          # vitest in the Workers runtime
pnpm typecheck
cp .dev.vars.example .dev.vars && pnpm dev
```

`ISSUER` (in `wrangler.jsonc`) is the multiplayer-token OIDC issuer; its JWKS is found through
`<issuer>/.well-known/openid-configuration`.

## Deploy

The Worker is configured for the `api.cinnabar.gg` custom domain and keeps
`cinnabar-api.cinnabar-api.workers.dev` available during migration. Deploying the domain requires
a Cloudflare token that can manage the zone. After the domain is live, update the Cinnabar client's
`CINNABAR_API_BASE_URL` and the website's API origin in their own repositories.

Create the private `cinnabar-api-cache` R2 bucket before the first deployment that binds `API_CACHE`:

```sh
pnpm exec wrangler r2 bucket create cinnabar-api-cache
```

CI deploys every push to `main` after the tests pass. The private cosmetics repository publishes its
own assets and catalog. The job runs in the `production` environment, whose `CLOUDFLARE_API_TOKEN` secret only
`main` can read. CI also copies the repository's `PRESENCE_READ_SECRET` Actions secret
into the Worker before deployment; configure the same value in the administrative consumer.
A manual deploy runs the Worker deployment after configuring secrets:

```sh
pnpm exec wrangler secret put RELEASE_HOOK_SECRET   # once
pnpm exec wrangler secret put PRESENCE_READ_SECRET  # same value as the consumer
pnpm exec wrangler deploy
```

The release hook rejects every request until `RELEASE_HOOK_SECRET` is set.

## License

Worker code: MIT. Original cosmetic artwork retains the license listed in the catalog
and [LICENSES/cosmetics.md](LICENSES/cosmetics.md).

## Cosmetics

`GET /v1/cosmetics/catalog` returns a versioned catalog with an ETag and a five-minute
public cache lifetime. Each item declares a namespaced ID, a slot, a display name,
free ownership, tags, a geometry identifier, an attachment bone, an offset in blocks
and render flags. Geometry, PNG texture and optional animation assets each declare a
URL, SHA-256 digest and byte count. The catalog includes original bunny ears, the crown, red devil horns, animated dragon wings and a shoulder parrot.
Catalog version 5 adds ten original items that fill every slot: studio headphones and a halo (`head`),
pixel shades and a kitsune mask (`face`), morpho wings and an ember jetpack (`back`), a fox tail and
a knit scarf (`body`), a bee buddy (`pet`) and an amethyst orbit (`aura`).
The shoulder parrot occupies the `pet` slot and appears in the wardrobe’s Pets category.
Dragon wings occupy the `back` slot and can be worn alongside a `head` cosmetic.
Their animation asset includes a looping rotation clip and a continuous `tip_flex` profile;
clients must support both before displaying this item.
The original artwork retains Cinnabar's [PolyForm Noncommercial 1.0.0 license](LICENSES/cosmetics.md).
The Worker code remains MIT-licensed.

Runtime assets and `cosmetics/catalog.json` live in the `COSMETIC_ASSETS` R2
bucket. The private cosmetics repository publishes hash-addressed objects first,
verifies their bytes, then promotes the catalog atomically. This Worker reads the
catalog with a one-minute isolate cache and serves the existing same-origin
`/v1/cosmetics/assets/:hash` URLs. The bundled metadata fallback preserves the
original free catalog when no valid R2 release is available. Authoring files and
production asset bytes are not bundled in this public repository.

Authenticated clients send `{type:"loadout", revision, slots:{head:"cinnabar:bunny_ears"}}`.
This replaces the account's connected-session loadout. Strictly newer revisions win
across its sockets; welcome advertises the current `loadout_revision`. Omitted slots
are empty and explicit `null` unequips a slot. The supported slots are defined in the
schema. Unknown slots and items are ignored; a known item in the wrong slot or
without ownership rejects the whole update with `invalid_loadout`.

Nearby watchers receive `{type:"loadout",xuid,uuid,revision,slots}` under the existing
mutual subscriptions. Loadouts survive hibernation without an emote lease. Visibility
opt-out, departure and the final socket closing withdraw them with empty slots.
A visibility or nearby change may repeat the same revision. Emotes keep their own
lease and no longer carry cosmetic state; `hat_id` and `cosmetic` are removed.

Free catalog items are owned by everyone. The Hub SQL `cosmetic_entitlements`
table owns `(xuid,item_id)` grants for paid items. The authenticated welcome sends
`owned_cosmetics`; grants and revocations send `cosmetic_ownership` to connected
account sockets. Loadout admission and replay check the database again, including
after hibernation. Display names never authorize ownership.

`POST /v1/cosmetics/entitlements` accepts `{xuid,item_ids,owned}` for explicit,
idempotent grants or revocations. Only a signed GitHub Actions OIDC identity from
the configured private repository ID, exact administration workflow, main branch
and manual dispatch is accepted. Ordinary client authentication cannot call it.
Use the private repository entitlement workflow; it writes database rows rather
than changing an account allowlist. No payment processing is implemented.

Optional animation JSON currently describes `wind` motion: an axis (`x`, `y` or `z`),
`max_degrees`, forward `speed` in blocks/second, `rise` and `fall` response rates,
and a `joints` map from authored bone names to weights in `[0,1]`. Clients validate
budgets and ignore unsupported items. `render_flags.double_sided` requests a reverse
face for each triangle.
`render_flags.emissive` draws every opaque texel fullbright in the world; wardrobe galleries and previews
are unchanged, and older clients draw the item normally lit.

An animation asset may also list up to eight `particles` emitters: a geometry `bone`, an `offset` in model
pixels from that bone's pivot, and a complete Bedrock particle `effect`. Clients follow the posed bone in
the world only, rename each effect to a client-owned identifier, and ignore the field when unsupported.
Effects may use the installed particle atlas or a 16x16 sprite region from the item's own texture (`atlas.cosmetic`).

## Cosmetic ownership

[The private cosmetics repository](https://github.com/cinnabar-mc/cinnabar-cosmetics)
owns editable Blockbench projects, textures, geometry, animation, emote sources,
exports, production catalog metadata and publication checks. Preserve artwork
license notices. This public Worker owns delivery and durable SQL entitlements;
its tests use shared synthetic fixtures and need no private repository access.

The private main-branch administration workflow can POST `{ "item_id": "namespace:item" }`
to `/v1/cosmetics/login-rewards` using the same GitHub OIDC identity as entitlement
updates. The item must already be published and restricted. First activation stores
a server-time start and a deadline exactly seven days later, returned as UTC ISO
timestamps. Retrying the request, including after expiry, returns the original dates.

Accounts that complete authenticated sign-in during `[starts_at, ends_at)` receive
permanent database ownership in their welcome message. Fresh accounts already
connected at activation also receive the item, including those hiding their presence.
Anonymous, unverified and stale connections do not qualify. Expiry is checked on
the server for each claim; no scheduled job or deployment is needed to stop grants.
Claims survive hibernation and reconnects, and manual revocations are not undone
by another sign-in. No window is started by deploying the API alone.

The same administrative identity can DELETE `{ "item_id": "namespace:item" }`
at `/v1/cosmetics/login-rewards` to stop a reward and revoke every ownership grant
for that item atomically. Connected clients receive updated ownership. Its claim
history is cleared, so an explicit later POST starts a fresh seven-day window.
Other items and their ownership are preserved.

Cinnabar owns downloading, validation, caching, rendering and focused regression
fixtures. Full catalog compatibility runs against the private checkout with
`CINNABAR_COSMETICS_CHECKOUT` and the client test
`api_catalog_assets_admit_through_client_validation`.

## Catalog emote clips

The optional catalog `emotes` array lists each clip's ID, display name, free
ownership, license and hash-addressed `clip` asset. Assets use the existing
cosmetics R2 route and immutable cache policy. Free clips are owned by everyone.
The catalog includes the original Breakdance sequence; authoring, sampling and
export checks live in the private cosmetics repository.

`schema/v1.json` owns the version 1 clip format and limits: duration and loop
metadata, fixed articulated joints, quaternion XYZW rotations and local offsets
in leg-height units. Clients reject unsupported versions, malformed channels and
oversized clips. Shared synthetic conformance cases in `schema/fixtures` exercise
the server validator and client parser. Publish the API assets before the client
that consumes them; older clients ignore the additional catalog field.

### Player-count history

A cron trigger records the authoritative online count once per minute, even when nobody visits the
website. Each minute keeps its first observation; delayed runs use their actual execution time.
Samples survive hub hibernation and are retained for 90 days. No account identifiers are stored.
History begins when collection is deployed; it cannot reconstruct earlier counts.

The cron publisher reads only new SQL samples after a checkpoint and updates chart buckets with
exact sums and observed peaks. The checkpoint and all chart ranges live in `API_CACHE` R2 storage.
Public history requests never call the Hub or read SQL. The first publication rebuilds the supported
windows from retained samples once; later publications and hibernation recovery read only new minutes.
An upload failure retains the previous snapshot and backs off across hibernation, then catches up
from SQL without inventing or duplicating observations. An empty history before the first publication
contains no points; a temporary R2 read failure returns 503 with a retry delay.

The history response includes `from`, `to`, and `interval_ms` in milliseconds. Each point contains
its bucket start (`at`), the average observed count (`online`), the highest observation (`peak`),
and the number of observations (`samples`). `to` identifies the published observation window, so it
can lag while publication is unavailable. The current bucket can be incomplete. Missing buckets
are omitted and must be shown as gaps, not zero. Averages and peaks cover observed minutes only;
a minute sample is not a record of every join and departure.

Mod release binaries use the `MOD_ASSETS` R2 binding and the isolated
`mod-releases/` prefix. The binding currently shares the existing asset bucket;
cosmetics keys and catalogue behavior are unchanged. Uploads require the dedicated
publisher credential, validate the actual bytes, and remain unavailable to public
GET requests until a release record commits. Metadata publication refuses absent
or size-mismatched objects and replaces the archive URL with the canonical API asset
URL. This permits anonymous native downloads while the source repository stays
private. Keep the GitHub URL in the publication request as publisher-scope evidence.

### Release download count

The download aggregate counts APK, DMG, EXE, MSI and AppImage assets, including
automatic update packages, on published `v`-numbered releases and the current
`nightly` release in the client repository. It excludes update manifests, checksums,
install scripts, debug archives and assets on unrelated releases. Repeat downloads
count; this is not a count of users or successful installations. Replaced or deleted
assets, including previous nightly packages, cannot be reconstructed.

Requests share a fifteen-minute snapshot in the existing `API_CACHE` R2 bucket,
plus a five-minute edge cache. A refresh reads all GitHub release pages before
replacing the snapshot; invalid responses, timeouts and rate limits return 503
without publishing a partial count. No GitHub credential is required.
