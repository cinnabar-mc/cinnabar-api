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
| `POST /v1/releases` | Release hook. `Authorization: Bearer <RELEASE_HOOK_SECRET>`, body `{"channel","version","build"}`; records and broadcasts only a newer (version, build) pair. Repeats and older records are no-ops. Omitted v1 builds mean zero. |
| `GET /v1/connect` | WebSocket. The client authenticates with a Minecraft multiplayer token plus an ES384 proof of its key, then can toggle visibility, look up which XUIDs or UUIDs recently used Cinnabar, and receives release pushes. |

Close codes: `4401` failed or timed-out authentication, `1009` frame over 16 KiB, `1007` frame
that isn't a JSON object with a `type`, `1008` invalid messages, binary frames, flood control or
repeated lookup rate limiting, and `1011` issuer unreachable. `4429` means stay away: its reason
is `retry_after=<seconds>`. Clients wait at least that long plus jitter before reconnecting,
and honour HTTP 429 `Retry-After` on dial. Unknown fields are ignored; unknown message types
are ignored after authentication. During the handshake only the expected message is accepted.
The text frame `ping` gets `pong` without waking the Hub.

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

- The public online count includes each visible connected account once, even with several sockets.
  Visibility off excludes that socket; an account counts while any of its open sockets is visible.
- Lookups answer “uses Cinnabar,” rather than providing an exact online status. Visible accounts
  linger in Hub memory for `PRESENCE_LINGER_MS` (30 minutes) after their last socket closes.
  Visibility off clears retained presence immediately; another visible socket can still make
  the account visible. Linger is best effort and is lost when the Hub hibernates or restarts.
- Presence UUIDs are derived from the verified XUID, never supplied by the client at login.
- Connection attachments survive hibernation and hold the XUID, UUID, visibility, channel, and socket
  flood counters. Handshakes (at most 10 s) temporarily hold the nonce, public key, client version
  and build. Display names and tokens are not stored in attachments or sent in welcome.
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

CI deploys every push to `main` after the tests pass: it uploads cosmetic assets missing from R2, then runs
`wrangler deploy`. The job runs in the `production` environment, whose `CLOUDFLARE_API_TOKEN` secret only
`main` can read. A manual deploy runs the same two steps:

```sh
pnpm exec wrangler secret put RELEASE_HOOK_SECRET   # once
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

Assets live in the `COSMETIC_ASSETS` R2 bucket, keyed by their SHA-256 digest. The
same-origin `/v1/cosmetics/assets/:hash` route streams only catalog-listed objects
with immutable cache headers. Before deploying, create the configured bucket and
upload each file in `assets/cosmetics/` under its filename. No bucket or deployment
is created by the tests.

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

Free catalog items are owned by everyone. The Hub's `cosmetic_entitlements` table
holds `(xuid,item_id)` grants for non-free items, checked before broadcasting. There
is no purchase or payment path. Payments, additional items and moderation remain
future work. Roll out the R2 assets and API first, then the matching client.

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

This repository owns the complete cosmetic catalog, editable Blockbench projects,
textures, animations, exporter and deployable assets. See [art/cosmetics](art/cosmetics/README.md)
for editing instructions. Run `pnpm check:cosmetics` before publishing; CI checks
every project against its exports and the catalog's packaged hashes and byte counts.
Keep the artwork's PolyForm Noncommercial license and attribution.

Cinnabar downloads, validates, caches and renders these assets. Its repository owns
renderer behavior and small stable regression fixtures, not a copy of each catalog
item. New items using supported features ship here alone. New rendering features
need client support and focused client tests before the catalog uses them.

For a full renderer compatibility check, point the client's
`api_catalog_assets_admit_through_client_validation` test at this checkout with
`CINNABAR_API_CHECKOUT`. This uses the actual API catalog and assets without copying
them into the client. It complements API export checks and client feature tests.
