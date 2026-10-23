# cinnabar-api

The [Cinnabar](https://github.com/cinnabar-mc/cinnabar) client's API: release notifications and player presence, as a Cloudflare Worker
(Hono) with one Durable Object. [`schema/v1.json`](schema/v1.json) is the machine-readable
contract (JSON Schema for every HTTP body and WebSocket message); the server validates inbound
messages against it.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | `{"ok":true,"api":"v1"}` |
| `GET /v1/presence/count` | Public `{"online":0}` count of unique connected, authenticated accounts with visibility on. Allows cross-origin reads and caching for 30 seconds. No identifiers or retained offline presence. |
| `GET /v1/presence/players` | Private `{"names":[]}` list of verified names for those same online accounts. Requires a bearer token matching the `PRESENCE_READ_SECRET` Worker secret; never cached or exposed through CORS. |
| `GET /v1/presence/history?range=24h` | Public anonymous player-count history. Ranges: `24h` (one minute), `7d` (ten minutes), `30d` (one hour). Allows cross-origin reads and caching for 60 seconds. |
| `POST /v1/releases` | Release hook. `Authorization: Bearer <RELEASE_HOOK_SECRET>`, body `{"channel","version","build"}`; records and broadcasts only a newer (version, build) pair. Repeats and older records are no-ops. Omitted v1 builds mean zero. |
| `GET /v1/connect` | WebSocket. The client authenticates with a Minecraft multiplayer token plus an ES384 proof of its key, then can toggle visibility, look up which XUIDs or UUIDs recently used Cinnabar, and receives release pushes. |

Public GET responses use Hono's Cache API middleware with lifetimes declared beside each route:

| Route | Cache lifetime |
| --- | --- |
| `/v1/health` | 60 seconds |
| `/v1/presence/count` | 30 seconds |
| `/v1/presence/history` | 60 seconds, separately for each query string |
| `/v1/cosmetics/catalog` | 300 seconds, with `If-None-Match` revalidation on cache hits and misses |
| `/v1/cosmetics/assets/:hash` | One year, immutable |

The cache is local to each Cloudflare location. Only successful public GET responses are stored;
requests with `Authorization`, private routes, writes and WebSocket connections bypass it.

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

## Mod marketplace

Players browse, send and report Cinnabar mods; creators submit them; staff review them. The website at
`MARKETPLACE_ORIGIN` is the only browser origin allowed to call these routes with credentials. The catalogue,
mod pages, files and revocations are public.

**Accounts are Xbox identities.**
- `GET /v1/auth/microsoft/start?return_to=` runs Microsoft OAuth with PKCE (`XboxLive.signin`, personal accounts).
- `GET /v1/auth/microsoft/callback` exchanges the code for an Xbox user token and then an XSTS token, keeps
  only the XUID and gamertag, and discards every token.
- It sets a `__Host-cinnabar_session` cookie (HttpOnly, Secure, SameSite=Lax). Only its SHA-256 is stored.
- The game's `/v1/connect` login proves the same XUID, so web and game accounts need no linking.
- Writes need the website `Origin` and the `X-Cinnabar-CSRF` token from `GET /v1/me`.
- Sessions last 30 days, or 12 hours for staff. A role change needs a sign-in from the last 10 minutes.
- XSTS refusals return to the site with `signin_error=no_xbox_profile|child_account|xbox_unavailable|cancelled`.

**Roles.**
- Players can submit, send and report.
- Moderators review and resolve reports.
- Admins also approve Acts and Network mods, pull versions, suspend accounts and manage moderators.
- Owners come only from `OWNER_XUIDS` and manage admins.
- Nobody reviews their own mod or changes their own role.
- Every staff action is written to `staff_audit`.

**Reach.** Each upload's `cinnabar:grants` section is read without compiling the component and filed on the
highest reach it touches. Reach sets the review rule:

| Reach | Capabilities | Approval |
| --- | --- | --- |
| Looks, Reads, Watches | drawing, reading the session, other players | one staff member |
| Acts | camera, controls, keys, item use, movement, attack reach, inventory, commands | an admin |
| Network | packet delay, session packets, WASI | two staff, one an admin |

Acts and Network listings must link their GitHub source.

**Files and trust.**
- Components (at most 16 MiB) and up to four raster images (1 MiB each) enter private
  `MOD_QUARANTINE` storage under server-computed SHA-256 keys. An authenticated,
  byte-bounded multipart request creates an immutable metadata snapshot and durable scan job.
- A separate scanner validates full component structure/types/core bytecode, host imports
  and image decoding without executing uploaded code. Workers AI assists staff with bounded,
  schema-validated findings. Missing, failed or expired checks prevent publication.
- Admins can establish a creator for a particular project after human review. Eligible updates
  publish automatically only with current trust and completed checks, unchanged content/imports,
  no added permissions or commands, and no suspension, withdrawal or open-report hold.
  Acts and Network releases always need human approval. See [the pipeline contract](docs/marketplace.md).
- An approved version is signed with the Ed25519 `MARKETPLACE_SIGNING_KEY` over a canonical statement
  `{approved_at, approvers, bytes, grants, sha256, slug, version}`, returned as `release` on `GET /v1/mods/:slug`.
- Pulled versions appear in `GET /v1/mods/revocations`, signed in `X-Cinnabar-Signature`.

**Send to game.**
- `POST /v1/mods/:slug/send` adds the current version to the player's library.
- It pushes `mod_library` to the player's live sockets, and `welcome` carries the library on every login.
- Pulling a version pushes it again with `pulled: true` and staff's `pull_reason`.

| Route | Who |
| --- | --- |
| `GET /v1/me`, `POST /v1/auth/signout` | anyone; returns `{account, library, csrf, game_online}` |
| `GET /v1/mods`, `GET /v1/mods/:slug`, `GET /v1/mods/assets/:sha256`, `GET /v1/mods/revocations` | public |
| `POST /v1/mods/:slug/send`, `POST /v1/mods/:slug/reports`, `GET /v1/me/mods` | signed in |
| `POST /v1/submissions` (multipart `listing` JSON and `file`) | signed in; five pending versions at most |
| `GET /v1/staff/queue`, `/reports`, `/people`, `/audit`, `/versions/:id`, `/versions/:id/file` | staff |
| `POST /v1/staff/versions/:id/decision` `{decision: approve, changes or reject, note}` | staff |
| `POST /v1/staff/reports/:id/resolve`, `POST /v1/staff/mods/:slug/hide` | staff |
| `POST /v1/staff/versions/:id/pull`, `POST /v1/staff/people/suspend` | admin |
| `POST /v1/staff/people/role` `{gamertag, role, reason}` | admin (moderators) or owner (admins) |

Before enabling it in production:

```sh
pnpm exec wrangler r2 bucket create cinnabar-mods
pnpm exec wrangler r2 bucket create cinnabar-mods-quarantine
pnpm exec wrangler secret put MARKETPLACE_SIGNING_KEY   # base64 PKCS#8 Ed25519 private key
pnpm exec wrangler secret put MARKETPLACE_SCANNER_TOKEN # separate random scanner credential
pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET   # only for a confidential Entra app
```

Then set the `MARKETPLACE_ORIGIN`, `MICROSOFT_CLIENT_ID` and `OWNER_XUIDS` variables.
- Register the Entra app for personal Microsoft accounts with the redirect URI
  `https://api.cinnabar.gg/v1/auth/microsoft/callback`.
- Sign-in answers 503 until the origin and client ID are set.
- The session cookie only reaches the API when the website shares its registrable domain (for example
  `cinnabar.gg`), so the site must leave `*.workers.dev` before sign-in works there.
- Keep both R2 buckets private with no public domains. Run the separate scanner with its
  limited credential and a Workers AI token; it never receives the signing key. Provisioning,
  scanner deployment and website HTTP enablement are separate from merging the API code.
  See [deployment and recovery](docs/marketplace.md#deployment-and-recovery).

## Privacy

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
  admission refusals, authentication failures, overload closes and lookups, with no identifiers
  or payloads. Counts are aggregated per invocation; failed metric writes are dropped without
  affecting admission or cleanup. Workers observability remains off so invocation logs do not
  record request metadata.
- Signing in to the marketplace stores the account's XUID, gamertag, role and last sign-in time.
  Sessions are stored as the SHA-256 of their cookie, with a CSRF token and creation time. Microsoft
  and Xbox tokens are never stored. Pending sign-ins keep a random state and PKCE verifier for at most
  ten minutes.
- The marketplace also keeps:
  - each player's sent mods
  - the reports they file, with their XUID and text
  - creators' listings and uploaded components
  - the staff audit log, which names the acting XUID

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
pnpm source:fetch # derive capabilities/imports from the immutable client revision in source.json
pnpm test          # vitest in the Workers runtime
pnpm test:scanner  # real component validation, image decoding and scanner protocol
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

CI deploys every push to `main` after the tests pass: it uploads cosmetic assets missing from R2, then runs
`wrangler deploy`. The job runs in the `production` environment, whose `CLOUDFLARE_API_TOKEN` secret only
`main` can read. CI also copies the repository's `PRESENCE_READ_SECRET` Actions secret
into the Worker before deployment; configure the same value in the administrative consumer.
A manual deploy runs the asset upload and Worker deployment after configuring secrets:

```sh
pnpm exec wrangler secret put RELEASE_HOOK_SECRET   # once
pnpm exec wrangler secret put PRESENCE_READ_SECRET  # same value as the consumer
node scripts/sync-cosmetic-assets.mjs
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

The history response includes `from`, `to`, and `interval_ms` in milliseconds. Each point contains
its bucket start (`at`), the average observed count (`online`), the highest observation (`peak`),
and the number of observations (`samples`). The current bucket can be incomplete. Missing buckets
are omitted and must be shown as gaps, not zero. Averages and peaks cover observed minutes only;
a minute sample is not a record of every join and departure.
