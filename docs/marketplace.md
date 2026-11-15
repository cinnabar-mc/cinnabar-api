# Marketplace API

Free mod releases use Cinnabar accounts with Google sign-in, private uploads, immutable release
snapshots, hand review by staff and Ed25519 publication. The website and client
must still enable their live integration and verify manifests and revocations.

## Accounts and Xbox delivery

Google sign-in uses server-side authorization code + S256 PKCE with `openid email`.
The server exchanges the code at `https://oauth2.googleapis.com/token` using the client secret
and verifier, then reads `sub`, `email` and `email_verified` directly from Google's
HTTPS OpenID userinfo endpoint, `https://openidconnect.googleapis.com/v1/userinfo`. This uses
the newly issued server-side bearer token instead of parsing an untrusted browser ID token,
and avoids a separate local JWKS cache and signature/claim validation path. Tokens are discarded.
See [Google's OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect).

Account resolution is provider-generic. `(provider, subject)` is the stable identity key.
A returning identity reuses its account even if its provider email changes. A new identity
may join an existing account only when its provider reports `email_verified: true` and the
trimmed, lowercased email matches exactly one account whose email is also verified. Unverified
or ambiguous matches create separate accounts. Email alone never authenticates an existing
identity. Future Discord, GitHub or password adapters must provide verified claims through
the same store rule; no such adapters are exposed yet. Owners are derived from a verified
account email in `OWNER_EMAILS`; a stored role cannot grant owner.

`GET /v1/me` returns:

```json
{"account":{"id":"opaque-account-id","username":null,"email":"player@example.com","role":"player","suspended":false,"xbox":null},"library":[],"csrf":"session-csrf","game_online":false}
```

Signed-out callers receive `account: null`, an empty library, `csrf: null`, and
`game_online: false`. A linked account instead has `xbox: {xuid, gamertag}`. Online means a
currently authenticated socket for that linked XUID. All creator, approval, report, role,
suspension, audit, session, CSRF and library references use the Cinnabar account ID.
Staff role/suspension writes accept `{account_id, role|suspended, reason}`; existing forms can
also supply a case-insensitive `username`. Audit role/suspension targets use account IDs.

`POST /v1/me/username` takes `{username: "Player_42"}` with the session, `X-Cinnabar-CSRF`
and the same trusted-Origin checks as other writes. A username can be chosen exactly once.
It must contain 3–16 ASCII letters, digits or underscores; case is preserved and uniqueness is
case-insensitive. Reserved names: cinnabar, admin, administrator, moderator, mod, staff, official,
support, system, root, owner, null, undefined. Success returns the updated `GET /v1/me` body.
Invalid or reserved names return 400 with the rules; taken and already-set names return 409.
Missing session returns 401, bad CSRF/untrusted Origin or suspension returns 403. Five attempts
per account per ten minutes are allowed, including invalid and taken names; excess returns 429.
Google account names are never read or stored. Accounts start with `username: null`, and public
creator and reviewer names use “Cinnabar player” until the account chooses a username.

`POST /v1/me/xbox/link-code` needs the session and `X-Cinnabar-CSRF`; it returns 200
`{code: "ABCD-2345", expires_in: 600}`. Codes contain eight random characters (40 bits) from
an alphabet excluding I, O, 0 and 1. Only the SHA-256 is stored. Each account has one live code;
issuing another replaces it. The limit is five issues/account per ten minutes, returning 429
when exhausted. Already linked accounts get 409 and must unlink first. Suspended accounts
cannot issue codes. `POST /v1/me/xbox/unlink` uses the same session and CSRF checks and returns
empty 204; it removes the binding and pending code, and pushes an empty library to the old Xbox.
Unlinking retains account-owned selections, so a newly linked Xbox receives them.

Enter the code in Cinnabar. On the existing authenticated `/v1/connect` socket the client sends
`{type: "account_link", code: string}` (at most 64 characters; case, spaces and hyphens are ignored).
The Hub uses only the connection's verified XUID and gamertag, never values in the message.
It replies `{type: "account_link_result", ok: true, account: {username: string | null}}` or
`{type: "account_link_result", ok: false, error: "invalid"|"expired"|"already_linked"|"rate_limited"}`.
Success consumes the code atomically with linking and immediately pushes `mod_library` to that
Xbox's connections. Replay returns `invalid`. Expired codes return `expired`; a valid code
cannot bind an already-linked Xbox or account (`already_linked`) until the website unlinks it.
Failed bindings do not consume the code. Ten attempts per connection are allowed; subsequent
attempts return `rate_limited`. The counter survives hibernation and ordinary frame flood
limits still apply. Schema v1 declares both messages and the website response shapes.

Game `welcome`, `mod_library`, game removals and pushes resolve account IDs through `xbox_links`.
Unlinked games have no library. `POST /v1/mods/<slug>/send` without a link returns 409
`{"error":"Link your Xbox account in Cinnabar first."}`. Xbox linking does not grant cosmetic
entitlements; those remain in the separate XUID-keyed entitlement table.

Additive marketplace migration 8 creates `accounts(id, display_name, email, email_verified,
role, suspended, created_at)`, `identities(provider, subject, account_id, email, email_verified)`
with unique `(provider, subject)`, `xbox_links(xuid, account_id, gamertag, linked_at)` with
unique XUID and account ID, `account_link_codes(code_hash, account_id, expires_at)` with unique
hash and account ID, and a bounded-time `account_link_attempts(account_id, at)` issuance ledger.
Legacy rows, if present, are mapped to random opaque IDs, their verified Xbox bindings preserved,
and every stored account reference re-keyed; `system:official` remains reserved. Legacy emails
start empty/unverified and legacy owner roles are demoted, since owner now requires a verified
configured email. The deprecated `market_accounts` table is retained for rollback diagnostics
and is never read by runtime authorization. Existing signed statements and asset URLs remain
byte-identical; their historical approver values are not rewritten. Startup migration and
multi-statement marketplace writes run in synchronous SQLite transactions. There was no
production web account data before this migration.

Migration 9 drops `accounts.display_name`, adds nullable `username` with a unique SQLite
`COLLATE NOCASE` index, and creates the username attempt ledger. It reserves `Cinnabar` for
`system:official`, including when the official account is created later. Existing sessions,
account references, signed release statements, signatures and digest asset URLs are preserved.

## Upload and release contract

`POST /v1/submissions` takes multipart `listing` JSON, one `file` component, and
optional repeated `images` files and `image_metadata` JSON. Image metadata is an
ordered array of `{caption, alt}`, with one entry per image (160 and 300 characters
respectively). Omitting it uses the filename as the caption. Identity comes from the host session cookie and
`X-Cinnabar-CSRF`. Authentication and the twenty-upload/hour account budget run
before reading the body. Five pending releases per creator are allowed.

Listing fields are `slug`, `name`, `summary`, `description` (40,000 characters),
`version`, optional GitHub `source`, category, license (128 characters) and release
notes (4,000 characters). Acts/Network releases require source. Slugs that are
fixed path segments under `/v1/mods/` (`revocations`, `assets`, `media`) and the system-owned `cinnabar-mod` are refused.
If the component declares a version it must match the listing version. The API
reads grants itself, rejects ambiguous/duplicate declarations, and hashes actual
bytes. Maximums are 16 MiB per component, four 1 MiB images, and 20 MiB + 256 KiB
for the whole request, enforced on streamed bytes independent of Content-Length.
A component's executable bytes, meaning everything except the top-level presentation
asset sections the client strips, must also fit the pinned client's ceiling (mod-host
`MAX_COMPONENT_BYTES`, 4 MiB at the current pin); a larger one is refused with 422,
since no client could load it. `pnpm source:fetch` derives that ceiling and the asset
section names from the pinned client revision.
Raster types are PNG, JPEG and WebP. SVG and active content are refused.

The listing icon comes only from the component's optional top-level custom section
`cinnabar:extension/icon@1`, containing encoded PNG bytes. No separate icon upload
or screenshot is required. Exactly one section is accepted, with an inclusive
256 KiB encoded-byte limit and width/height in `1..=256`, matching the client's
section, byte and dimension rules. Missing sections yield no icon; duplicate,
oversized or structurally invalid icons also yield no icon without rejecting the
submission. The private version view records the reason as `icon_error` (null for
a missing or valid icon).

The Worker checks the PNG signature, IHDR first and exactly once, legal IHDR
fields, bounded chunk lengths and CRCs, critical chunk order, palette framing,
IDAT presence, and a final empty IEND with no trailing bytes. Unlike the client,
which decodes PNG pixels, this structural check does not inflate IDAT, validate
pixel/filter data or fully interpret ancillary chunks. A PNG with corrupt
compressed pixels can therefore pass extraction but fail client decoding.
Staff look at creator images during review; nothing else decodes them before publication.

A valid icon is stored as `media/<sha256>` with `image/png` content type and an
immutable media descriptor `{sha256, bytes, type: "image/png", caption: "", role: "icon"}`.
The pipeline snapshot, digest index and signed release's
`media` include it alongside up to four gallery images. Existing media without a
role remains gallery media; `gallery` responses exclude icons. Existing signed
versions are not rewritten or backfilled. Additive migration 10 adds nullable
`mod_pipeline.icon_error` without changing those snapshots or signatures.

All bytes enter `MOD_FILES` directly, under `mods/<sha256>` or `media/<sha256>`.
The R2 bucket must have public access disabled. Publication signs the release and
changes API download authorization; it does not copy artifacts between buckets.
Pending metadata never edits a public listing. Release bytes, grants, listing
text and media references cannot be edited
in place; submit another version. An upload refused after R2 writes can leave
unreferenced objects; include orphan reconciliation in storage operations. Do not
expire referenced objects automatically: pending and published releases need them.

Before upgrading an installation that used `cinnabar-mods-quarantine`, pause upload
writers and copy its referenced objects into `cinnabar-mods`, preserving
keys, bytes and content types. Verify component and image access before resuming.
The code change removes the old binding; it does not delete the old bucket or data.

`GET /v1/me/mods` and staff version views include:

- `status`: `submitted`, `approved`, `changes` or `rejected`;
- `publication`: `manual`, `official`, `automatic` (published by the retired scanner) or null while pending;
- immutable description and `gallery` descriptors `{sha256, bytes, type, caption, alt}`;
- `icon: string | null`, a root-relative authenticated preview URL
  `/v1/me/mods/<id>/media/<sha256>` for that version, including pending versions;
- private `icon_error: string | null`, explaining why an embedded icon was ignored.

Public summaries (`GET /v1/mods`) and details (`GET /v1/mods/<slug>`) include
`icon: string | null`, using the root-relative URL `/v1/mods/media/<sha256>` from
the approved live version's immutable media snapshot. Pending releases cannot
change that URL. Approving a version without a usable icon changes it to null;
gallery images never supply an icon fallback. Public responses omit `icon_error`.
The Official Mod publication hook extracts and stores its component icon through
the same media contract, with the same version-bound publication/withdrawal rules.

Public component/media URLs are `/v1/mods/assets/<sha256>` and
`/v1/mods/media/<sha256>`. Authorization is checked on each request with one indexed
digest lookup. Only signed, approved, unpulled releases with an active creator and
visible listing qualify. These checks have no per-client rate limit; they stay cheap instead.
Responses use `no-store` and `nosniff`; private files never use a public cache path.
Staff fetch submitted components through `/v1/staff/versions/<id>/file`.
Clients fetch the exact signed statement and signature from
`GET /v1/mods/<slug>/releases/<version>/<sha256>`, including an older approved library selection.
Pulled, hidden, unsigned or suspended-creator releases are unavailable. Revocations
include signed millisecond `issued_at` and `expires_at` timestamps, valid for fifteen
minutes. Clients must reject expired/rollback snapshots, retain known revocations,
and hold managed mods when current revocation evidence is unavailable. The Hub reuses
one signed list for up to thirty seconds until a pull changes it, and the edge caches
it for sixty, so a list may be up to ninety seconds old when fetched. Clients refuse
bodies over 1 MiB, so a pull that would make the body exceed 768 KiB returns 409; an
operator must compact old revocations before more versions can be pulled.
An authenticated game socket can send `mod_library_remove` with `slug`, `sha256`
and the exact `sent_at` timestamp. It removes that account's matching selection
and broadcasts its new library; stale requests cannot remove a later website send.
Browsers use `POST /v1/mods/<slug>/remove` with JSON `{sha256, sent_at}`, the host
session cookie and `X-Cinnabar-CSRF`. Identity comes only from that session.
A changed selection returns 409 so the website refreshes before another attempt.
An account's persisted send clock advances timestamps even within the same clock
millisecond, after deletion/re-addition and across restarts or clock adjustments.
Its high-water mark is retained independently of active library entries.
Removal works for hidden/pulled releases and does not uninstall local files.
Creators and active staff fetch pending screenshots and icons through authenticated
`GET /v1/me/mods/<id>/media/<sha256>`; other accounts receive 404. Public listing
responses include grants, category/license, release notes/history and publication mode. Previous-version review data includes
the exact prior hash and grants. Clients derive media URLs from these digests;
creator-provided URLs never select storage objects.

## Staff review and publication

No automated scan runs. Staff download a submitted component through
`/v1/staff/versions/<id>/file`, review it and its images by hand on their own
devices, and then approve, reject or ask for changes. Looks, Reads and Watches
need one moderator approval. Acts needs an admin; Network needs two distinct staff
approvals including an admin. Nobody reviews their own mod, except an owner, whose
own approval publishes their mod by itself at any reach. Every creator release,
including an update to a previously approved project, waits for these approvals;
nothing publishes automatically. The upload-time reader checks component framing,
declarations, grants and the executable size ceiling; it does not validate types,
core bytecode or host imports, and it never runs uploaded code. The client remains
responsible for ABI compatibility, runtime isolation and explicit permission consent.

Marketplace schema migration 12 drops the retired scanner's Workers AI ledger and
returns releases that the scanner had queued for automatic publication to the
review queue. Releases it already published keep `publication: "automatic"` and
their signed statements. The `mod_trust` table and old scan columns stay in place
but are no longer read.

Staff cannot hide or restore their own listing or resolve reports about their own mod.
Any staff member can hide a listing; only admins can restore one. The hide route's
`hidden` field and the suspend route's `suspended` field must be booleans; anything
else is a 422 and changes nothing. Role and suspension requests from callers who can't
make them are refused with 403 before the account ID is looked up, so they reveal
nothing about which accounts exist.

Publication confirms the files exist and signs a statement binding the
hash, grants, snapshot, media, client revision, policy and publication
mode, then rechecks all live gates after I/O before atomically marking approved.
Unsigned or interrupted releases stay private. Cron retries committed publication
decisions; a missing key or file returns 503 and leaves a recoverable decision.
Public listing, download and send-to-game paths all require an actual signature.

`GET /v1/mods/<slug>/update` is an anonymous, uncached compatibility check. Supply
`api_revisions` (1–32 comma-separated full lowercase 40-hex supported stable API
revisions), `host_revision` (full lowercase 40-hex), `current_version` (stable
`major.minor.patch`) and `current_sha256` (full lowercase 64-hex). It returns
`{release: {statement, signature}}` for the numerically highest newer published
version whose digest differs and whose stored API revision is supported, or an
empty 204. Malformed queries receive 400; missing/hidden listings and suspended
creators receive 404. `Cache-Control: no-store` applies to all these responses,
so publication, pulls and visibility changes apply on the next request. The host
commit identifies the caller; selection uses supported API revisions rather than
requiring an equal client build pin. No account, cookie or compatibility fallback
is involved. The first-party `/v1/mod/update` response contract is unchanged; it now
selects official marketplace versions and unshadowed legacy releases as described below.

`source.json` fetches the pinned client's `crates/mod-api/compatibility-revisions.json`.
Contract derivation requires a nonempty JSON array of full lowercase 40-hex
revisions, ordered oldest to newest, and takes the last entry as `api_revision`.
Submission records that value. The signed release statement appends this
field after `publication`. Existing stored statements remain byte-identical.
Marketplace schema migration 6 adds nullable `mod_versions.api_revision` and the
`mod_versions_updates (slug, api_revision)` index without backfilling compatibility;
legacy versions with no stored revision never match update queries.

## Official Mod publication and shipped clients

The reserved slug `cinnabar-mod` belongs to `system:official`, a system identity
outside the random user-account namespace, displayed as Cinnabar. Creators cannot claim it,
even before its first release. It appears in the normal catalogue and supports
normal send, update, exact-release, signed revocation and administrative pull routes.
Its listing does not reveal the private publishing repository. Embedded license
text is retained in its immutable listing snapshot.

Existing CI continues to upload through `PUT /v1/mod/assets/<sha256>` and publish
`{manifest, download_url}` through `POST /v1/mod/releases`, using the dedicated
`MOD_RELEASE_HOOK_SECRET`. The native `POST /v1/releases` hook is unchanged and
accepts only its `{channel, version, build}` body. The mod hook runs
`publisherAllows`: package, host repository, publishing repository and immutable
GitHub version/filename URL must match the configured values. It never fetches
that GitHub URL. Mod hook bodies retain their 16 KiB limit; native notification
bodies retain their 1 KiB limit. Upload authorization is unchanged.

Authenticated official CI is the approval authority. It uses publication mode
`official` and policy `cinnabar-official-hook-2026-11-08-v1`, rather than claiming a
staff review. Before recording approval, the API reads the stored
object, verifies its actual SHA-256 and size against the manifest, and runs the
shared deterministic component framing/declaration/grants reader. This rejects
malformed or duplicate declarations, unknown grants, mismatching declared versions,
and executable content beyond the pinned host ceiling. The existing 32 MiB
transport limit remains. This is not full component/type/core-bytecode validation;
the trusted official build pipeline remains responsible for producing a valid ABI.
It deliberately does not require the API's pinned API generation, so official
releases can still target older supported generations.

A completed official pipeline row has separate recorded validation evidence in
`mod_official_releases.validation`, exposed to staff as `official_validation`.
Publication requires
that evidence, the reserved listing/creator, the object and a signature. The signed
statement uses exactly the existing fields: `api_revision` comes from the original
manifest, `client_revision` from its host build revision, `approvers` is
`["system:official"]`, and `policy`/`publication` identify official approval. The
original manifest, including package, mod revision, host repository/revisions,
artifact filename/size/digest and normalized legacy download URL, is retained
verbatim after the same unknown-field canonicalization as the old hook. Identical
retries do not change timestamps, evidence or signatures; changed metadata returns
409. Byte validation failures return 409 before a decision is recorded. Missing
signing or publication-time storage resources return 409 with a private, durable
publication decision; retrying or cron recovers it. Pulling never gets undone by
a hook retry.

Marketplace schema migration 7 adds only `mod_official_releases(version_id,
release, validation)`. An additive `mod_releases_digest` expression index keeps
legacy digest authorization indexed. No destructive catalogue migration or asset
backfill runs: existing legacy releases have no reliable full validation evidence,
and the old publisher accepted only a component header. Shipped clients therefore
read a union of their original `mod_releases` rows and published official marketplace
versions. A committed marketplace release permanently shadows the same legacy
version, including while hidden or pulled, preventing resurrection through fallback.
An interrupted migration leaves its already-public legacy release available until
the marketplace signature commits; new unsigned versions remain private.
Replaying an unchanged legacy manifest through the hook validates and migrates
that version; changed legacy metadata remains a conflict.

The old routes keep their URLs, bodies and status codes, without redirects:

- `GET /v1/mod/update` returns the original `{manifest, download_url}` for the
  numerically highest newer compatible official release, or empty 204. Full host
  and installed revision identities, supported API list, current version and
  different mod revision retain their old checks. There is no API fallback.
- `GET /v1/mod/download` streams the newest eligible official component with its
  original filename, or 404. Optional query parameter `channel` accepts `stable`,
  `beta` or `nightly`, defaults to `beta`, and returns 400 for any other value.
  Selection uses only that channel's latest reported host API revisions across
  the legacy/marketplace union above, with the same visibility and pull rules.
  If the selected channel has never reported, selection falls back to the union
  of all channels' reported revisions; if no channel has reported, no revision
  is excluded. Once the selected channel has reported, an empty report excludes
  every version even if other channels support them. Responses remain `no-store`.
- `GET /v1/mod/assets/<sha256>` streams the same original bytes, or 404. It and
  all official public downloads now use `no-store` so new requests observe pulls.
  Previously cached immutable responses cannot be recalled from existing caches.
- `GET /v1/mods/cinnabar-mod/update` uses the normal signed marketplace update
  contract; exact signed releases and send-to-game work normally. Pulls exclude
  the version and its digest from both legacy and marketplace selection/downloads,
  even when another official version or legacy row references identical bytes.

Official objects stay only in `MOD_ASSETS` at `mod-releases/<sha256>` (currently the
`cinnabar-cosmetics` bucket). Marketplace signing and download routes select that
object directly; they never copy it into `MOD_FILES`. Creator uploads continue to
use `MOD_FILES` at `mods/<sha256>` unchanged. Staff can inspect unpulled official
objects through the existing authenticated version-file route. Official detail
pages and the catalogue after first official publication bypass edge caching,
including when pulled/hidden, so official signed metadata is never placed in the
edge cache. A catalogue cached before first official publication can omit the new
listing for up to the existing thirty-second lifetime.
The signed revocation endpoint retains its existing bounded cache lifetime.

Deployment needs the existing marketplace signer (with its client public-key pin)
and access to the existing `MOD_ASSETS` binding; no new secret or bucket is needed.
Keep the existing official package, repository, host repository, download base URL
and dedicated publisher credential. No Official Mod repository or CI change is
required. Legacy rows can be migrated individually by replaying their original
manifests after confirming their assets pass the new validation. Test staging
with a real official artifact before deployment; synthetic tests do not establish
that a production artifact matches the pinned reader or client ABI.

## Deployment and recovery

The API deploys only from `main` through its existing `production` environment.
Create the private `MOD_FILES` R2 bucket before merging. Configure `MARKETPLACE_ORIGIN`,
replace `GOOGLE_CLIENT_ID`'s `REPLACE_WITH_GOOGLE_CLIENT_ID` placeholder with the real Google
OAuth web client ID, and set `OWNER_EMAILS` to comma-separated owner emails (trimmed and
case-insensitive; only verified account emails qualify). Google requires authorized redirect URI
`https://api.cinnabar.gg/v1/auth/google/callback`. For another API origin, register its identical
callback path too: the callback URI is derived from the API request origin.
Set Worker secrets `MARKETPLACE_SIGNING_KEY` and `GOOGLE_CLIENT_SECRET`. Never place
credentials in this repository. The production GitHub environment must contain
`GOOGLE_CLIENT_SECRET`: deployment installs it with `wrangler secret put`, just like the signer. An empty secret fails deployment loudly rather
than silently retaining an unknown old credential or deploying broken sign-in. Pull requests
never receive these secrets. Missing configuration (including the client-ID placeholder)
returns 503 from both Google auth endpoints.

Web sign-in keeps no server state until Google returns the browser. The start route
seals the provider, OAuth state, PKCE verifier and validated return address with AES-256-GCM in a
ten-minute `__Host-cinnabar_oauth` cookie (HttpOnly, Secure, SameSite=Lax). Its key is
derived from `MARKETPLACE_SIGNING_KEY` with HKDF-SHA256 under a fixed purpose label, so
sign-in needs that secret and rotating it voids sign-ins in progress. The callback
clears the cookie and refuses one that is missing, altered, expired, for another provider or
another state. Google redeems each authorization code once. Failed state validation redirects
to the configured site's `/mods/?signin_error=failed`; other failures return to the sealed
`return_to` with `signin_error=failed` or `cancelled` (consent denied). None write to the Hub.
Signed-in routes called without a session cookie get their signed-out answer from the Worker.

For the initial signer, run `node scripts/marketplace-signing.mjs provision /path/to/client-checkout`.
It generates Ed25519 material in memory, sends the PKCS#8 private half on stdin to
GitHub's encrypted `production` environment secret, and writes only the raw public
half to the client key set. It refuses to replace an existing signer. Review and
publish that client pin, update this repository's immutable `source.json` revision,
and run `pnpm source:fetch`. Main deployment checks the secret against those client
inputs before configuring the Worker. Pull requests never receive the secret.
Keep the client and API trust pins aligned; rotate deliberately with overlapping
client public keys before changing the signer. Local fixtures use a separate key.

Monitor the staff queue and pending publications. If signing/storage fails, restore
the resource; cron retries eligible publications. During incidents, pull
affected releases, and rotate compromised credentials. Keep an audited retention
and orphan cleanup process for stored artifacts and reports.

Production enablement still requires real-domain OAuth and staging end-to-end
checks, website live-mode wiring, and client signature/revocation enforcement.
Tests use synthetic artifacts and do not deploy infrastructure.

## References

- [Workers request body limits and streaming](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers WebAssembly restrictions](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
