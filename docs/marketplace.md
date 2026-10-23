# Marketplace API

Free mod releases use Microsoft/Xbox identity, private uploads, immutable release
snapshots, a durable scanner outbox and Ed25519 publication. The website and client
must still enable their live integration and verify manifests and revocations.
AI findings assist moderation; they are not a safety certification.

## Upload and release contract

`POST /v1/submissions` takes multipart `listing` JSON, one `file` component, and
optional repeated `images` files and `image_metadata` JSON. Image metadata is an
ordered array of `{caption, alt}`, with one entry per image (160 and 300 characters
respectively). Omitting it uses the filename as the caption. Identity comes from the host session cookie and
`X-Cinnabar-CSRF`. Authentication and the twenty-upload/hour account budget run
before reading the body. Five pending releases per creator are allowed.

Listing fields are `slug`, `name`, `summary`, `description` (40,000 characters),
`version`, optional GitHub `source`, category, license (128 characters) and release
notes (4,000 characters). Acts/Network releases require source.
If the component declares a version it must match the listing version. The API
reads grants itself, rejects ambiguous/duplicate declarations, and hashes actual
bytes. Maximums are 16 MiB per component, four 1 MiB images, and 20 MiB + 256 KiB
for the whole request, enforced on streamed bytes independent of Content-Length.
Raster types are PNG, JPEG and WebP. SVG and active content are refused.

All bytes enter `MOD_QUARANTINE`, under `mods/<sha256>` or `media/<sha256>`. Both
R2 buckets must have public access disabled. Pending metadata never edits a public
listing. Release bytes, grants, listing text and media references cannot be edited
in place; submit another version. An upload refused after R2 writes can leave
unreferenced objects; include orphan reconciliation in storage operations. Do not
expire referenced quarantine objects automatically: interrupted promotions need them.

`GET /v1/me/mods` and staff version views include:

- `status`: `submitted`, `approved`, `changes` or `rejected`;
- `scan`: `state` (`queued`, `running`, `complete`, `failed`), attempts, job ID,
  completion/expiry time, authoritative `review_ready`, deterministic findings and structured AI evidence;
- `publication`: `manual`, `automatic` or null;
- immutable description and `gallery` descriptors `{sha256, bytes, type, caption, alt}`.

Public component/media URLs are `/v1/mods/assets/<sha256>` and
`/v1/mods/media/<sha256>`. Authorization is checked on each request. Only signed,
approved, unpulled releases with an active creator and visible listing qualify.
Responses use `no-store` and `nosniff`; private files never use a public cache path.
Staff fetch quarantined components through `/v1/staff/versions/<id>/file`.
Creators and active staff fetch pending screenshots through authenticated
`GET /v1/me/mods/<id>/media/<sha256>`; other accounts receive 404. Public listing
responses include grants, category/license, release notes/history, publication mode
and a scan summary without private findings. Previous-version review data includes
the exact prior hash and grants. Clients derive media URLs from these digests;
creator-provided URLs never select storage objects.

## Durable scan protocol

`mod_pipeline` is a SQL outbox created in the same synchronous transaction as the
release. No network call must succeed to enqueue work. Independent consumers poll:

| Route | Request / result |
| --- | --- |
| `POST /v1/internal/marketplace/claim` | Returns `{job: null}` or a job with a random lease, exact hash/size, listing, grants, images and prior release evidence. |
| `GET /v1/internal/marketplace/jobs/<job>/files/<sha256>` | `X-Scan-Lease` selects only a file attached to that unexpired job. |
| `POST /v1/internal/marketplace/jobs/<job>/complete` | `X-Scan-Lease`, bounded JSON attestation. Hash, media hashes, validator, pinned client revision and policy must match. |

These routes require `Authorization: Bearer <MARKETPLACE_SCANNER_TOKEN>`. This
credential cannot authenticate as staff or sign a release. Keep it separate from
Microsoft credentials, production deployment credentials and the release key.
Only trusted scanner processes receive it; a compromised scanner is a security
incident requiring credential rotation, trust revocation and release review.

Claims last five minutes. Concurrent claims are serialized by SQLite. Expired
claims can be reclaimed up to three attempts; exhaustion becomes `failed`, which
cannot publish. Duplicate identical completions are idempotent; stale leases,
wrong job/hash/policy/client revision and inconsistent reports are rejected.
Completed/failed jobs keep their evidence. Staff can request a fresh job through
`POST /v1/staff/versions/<id>/rescan`, which invalidates old claims and approvals.

The Node scanner runs full Jco/Wasmtime component translation and validates nested
core bytecode without importing generated bindings or executing start functions.
It compares imports to the pinned client WIT and checks required callbacks. Images
must fully decode in sharp, be single-frame, and fit 4096 × 4096 / 16,777,216 pixels.
It uses a disposable credential-free thread and a thirty-second deadline. Run the
container with OS memory/CPU limits as native/Wasm allocations exceed JS heap limits.
Client capability types and interface names are derived from `source.json`; no
separately maintained permission snapshot is authoritative.

The AI receives bounded declarations, listing text, import/export evidence,
permission diffs and printable strings, with a fixed system instruction treating
all packet contents as hostile data. It has no tools and fetches no creator URLs.
Workers AI JSON mode and local schema validation are both required. The report
records the configured model, prompt version, validator and policy. Provider
failure, invalid JSON, missing configuration or timeout produce an error hold.
AI cannot alter hashes, grant trust, approve a deterministic block or sign releases.

This first policy uses static evidence. It does not execute guest code, scan
repository sources or claim to detect every malicious behavior. Host imports
outside the pinned WIT contract are blocked; unsupported WASI interfaces require
a reviewed policy extension. The client remains responsible for exact ABI/type
compatibility, runtime isolation and explicit user permission consent.

## Human and automatic publication

Looks, Reads and Watches need one moderator approval. Acts needs an admin; Network
needs two distinct staff approvals including an admin. Nobody reviews their own
mod. Every approval requires a complete passing deterministic scan and a successful
AI response completed within twenty-four hours. AI flags require an explanatory
review note. Deterministic blocks and failed/incomplete scans cannot be overridden.

An admin with a sign-in less than ten minutes old can call
`POST /v1/staff/mods/<slug>/trust` with `{trusted: true|false, reason}`. Trust is
project/creator scoped, audited, revocable, lasts ninety days and cannot be
self-granted. Establishing trust requires an active creator, visible current
release and at least one unpulled human-approved release. Downloads or AI confidence
never establish trust.

Automatic publication additionally requires a clear AI response, reach below Acts,
the exact approved baseline captured at submission, no additional permissions or
command values, no new imports, unchanged listing/source/media content, current
trust, and no open report. Suspensions, hiding or pulling delete relevant trust;
restoration requires deliberate administrative review. Concurrent updates that
change the baseline fall back to human review. Metadata/image changes also need
human review at launch.

Publication copies immutable files to `MOD_FILES`, signs a statement binding the
hash, grants, snapshot, media, client revision, scan job, policy and publication
mode, then rechecks all live gates after I/O before atomically marking approved.
Unsigned or interrupted releases stay private. Cron retries committed promotion
decisions; a missing key or failed copy returns 503 and leaves a recoverable decision.
Public listing, download and send-to-game paths all require an actual signature.

## Deployment and recovery

The API deploys only from `main` through its existing `production` environment.
Create both private R2 buckets before merging. Configure `MARKETPLACE_ORIGIN`,
`MICROSOFT_CLIENT_ID`, `OWNER_XUIDS`, the Microsoft app callback and Worker secrets
`MARKETPLACE_SIGNING_KEY`, optional `MICROSOFT_CLIENT_SECRET`, and
`MARKETPLACE_SCANNER_TOKEN`. Never place credentials in this repository.

Build the separate scanner image from the repository root:

```sh
docker build -f scanner/Dockerfile -t cinnabar-mod-scanner .
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --env-file /secure/path/scanner.env cinnabar-mod-scanner
```

The secret file supplies `MARKETPLACE_API_ORIGIN` (an HTTPS origin),
`MARKETPLACE_SCANNER_TOKEN`, `AI_ACCOUNT_ID` and an `AI_API_TOKEN` scoped only to
Workers AI. Optional `AI_MODEL` defaults to
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, which supports JSON mode. Give the
container no signer, cloud deployment, R2 or database credentials. Its egress needs
only the configured API and Cloudflare AI. A supervisor should restart it after
failure. Multiple instances are supported; the SQL lease prevents duplicate work.
For local fixture development use `pnpm source:fetch`, `pnpm scanner:build`, then
`pnpm scanner:start` with equivalent environment variables.

Monitor fixed `scan_completed` / `scan_retry_pending` scanner events, staff queue
scan states, expired claims and pending promotions. Reconfigure/restart a failed
scanner, then rescan held releases. If signing/storage fails, restore the resource;
cron retries eligible promotions. Revoke creator trust during incidents, pull
affected releases, and rotate compromised credentials. Keep an audited retention
and orphan cleanup process for quarantined artifacts and stored reports.

Production enablement still requires real-domain OAuth and staging end-to-end
checks, scanner infrastructure/secrets, website live-mode wiring, and client
signature/revocation enforcement. Tests use synthetic artifacts and mocked AI;
they do not call production inference or deploy infrastructure.

## References

- [Workers request body limits and streaming](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers WebAssembly restrictions](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
- [Workers AI REST authentication](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Workers AI JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [sharp input validation and pixel limits](https://sharp.pixelplumbing.com/api-constructor/)
