# Recording ownership transfer

The server actions in `apps/web/actions/organization/recording-ownership-transfer.ts`
provide a separate, conservative transfer path for one completed recording within
its organization. Organization content settings link to the dedicated manager page
at `/dashboard/settings/organization/content/recording-ownership`. The existing
organization content-transfer workflow is unchanged.

An organization owner or administrator selects a target member and an optional
existing private personal folder owned by that member. Passing `null` normally
places the recording at the target's root. A public personal folder association is
preserved because its collection lists recordings using `videos.folderId`; a
request to move that recording to a different folder is held. Organization and
space collections use their respective sharing rows, which remain unchanged.
Organization and space sharing rows, share IDs,
passwords, visibility, viewer grants, comments, source folders, and sibling
recordings are preserved. No folder is moved or deleted. Processing is not restarted.

## Calling sequence

The page requires an existing authenticated NextAuth session for an owner or
administrator of the active organization. Each action independently rechecks that
session, current role, organization, recording and target; page access alone grants
no authority. Visiting the page performs no challenge preparation or transfer.
Operators enter the recording, destination member and optional folder IDs.

If completion evidence is missing, explicitly download a preflight challenge, give
it to an already authorized trusted operator through the established private
channel, and load the returned receipt file. Neither token is displayed, placed in
a URL, written to browser storage, or logged by this caller. The download contains
confidential signed GET capabilities: protect the downloaded file and exclude it
from telemetry, support attachments and public artifacts. Do not supply the
verification secret to the browser. Changed inputs clear the receipt and preview.
The existing Server Action body limit is unchanged; an unusually large receipt may
be held before the library limit.

1. Call `previewRecordingOwnershipTransfer` with `videoId`, `targetUserId`, and
   `destinationFolderId`. This dry-run performs reads only and returns either a
   `previewToken` and object count or a generic hold reason.
2. Call `startRecordingOwnershipTransfer` with the same inputs, that token, and a
   stable caller-generated `requestId`. Reusing the same request is idempotent;
   changed inputs require a new preview and request. IDs use the existing maximum
   length of 15 and accept letters, digits, underscores, and hyphens.
3. Poll `getRecordingOwnershipTransfer`. A lost dispatch response leaves a durable
   journal. `retryRecordingOwnershipTransfer` resumes the same copying operation.
4. Call `rollbackRecordingOwnershipTransfer` with `dryRun: true` before attempting
   rollback with `dryRun: false`. Before publication this cancels the operation;
   afterward it restores ownership and active references only if the recorded
   snapshot, original folder context, and both media inventories remain unchanged.
   Cancellation before publication requires a current authorized organization
   manager, even if the original owner has left. Restoring applied ownership still
   requires the original owner to be an eligible organization member.

The page exposes these actions with explicit preview/start and dry-run/rollback
controls. It creates a request ID before dispatch, displays it, and preserves the
same input and ID after an uncertain response. Save the operation ID privately:
after a reload, use the status field and retry that existing operation. The page
does not persist tokens or recover an unsaved operation ID from browser storage.
Status refresh is manual. Cancel and re-qualify stale proof; do not start another
operation to work around an unresolved response.

Operation state uses the existing `agentApiOperations` table and content-transfer
kind, with a versioned payload and `preserve_recording_sharing` mode. The organization
row lock coordinates admission with the existing content-transfer workflow. The
operation journal stores only the rollback fields, object verification details,
and snapshot hashes needed by this path. Status responses contain no media keys
or object metadata. Failures use generic codes.

## Media verification and publication

The plan inventories the entire source recording prefix, including unreferenced
original media. Every object must be nonempty and have stable size, identity,
SHA-256, content type, and metadata. Required references must exist within that
prefix. Processing receipts, source inventories, paged inventories, and completed
manifests use explicit strict schemas. Unknown fields, reference forms, and schema
versions are held. Every accepted archived object reference is checked against its
retained original, including identities, content hashes, sizes, and page ranges.

A complete upload row qualifies the upload state. When finalization has removed
that row, a separate legacy qualification requires a valid full-decode receipt
bound to the selected playable output and two matching complete source inventories.
An absent row or an existing `result.mp4` alone is insufficient. Qualification is
bound into the preview and rechecked under locks at publication. A separately authenticated
standalone ownership preflight can qualify otherwise receipt-less MP4 recordings;
see the preflight trust contract below. Active processing,
edits, and transcription remain holds. A retired `source-blocked` job whose reason
is `output-replaced` can qualify with valid evidence; its guard is preserved.

Copies use conditional multipart publication, including for small objects:
source parts require the recorded identity, and completion requires the destination
to be absent. Existing destinations are reused only after full content and metadata
verification. Copy readback and a second complete inventory check precede the
database transaction. Arbitrary object metadata and MIME parameters are removed;
only validated technical metadata is copied. Originals and partial destination
copies are retained after success, failure, cancellation, and rollback.

The short publication transaction rechecks authorization and the recording snapshot
under row locks, then atomically changes ownership, the destination folder, active
`videos.source` keys, upload and edit source keys, upload receipt keys and identity,
and media-comment keys. Media-comment creation locks the video and rejects an upload
authorized against a previous owner or storage location. Concurrent workers cannot
publish the same operation twice or overwrite a conflicting destination.

Finalized processing jobs and archived JSON receipts remain immutable and continue
to reference the retained original objects. Transcription, captions, thumbnails,
previews, raw media, and derivatives under the recording prefix are copied even
when their keys are derived rather than stored in a row.

## Conservative holds and limits

- Only completed `desktopMP4` and `webMP4` recordings using the same S3 bucket are
  supported. Drive integrations, screenshots, legacy segment/HLS source types,
  incomplete uploads, unfinished processing, unknown source fields, and unsupported
  MIME types are held before publication.
- Inventories are bounded to 10,000 objects; archived JSON objects are bounded to
  4 MiB each. Media is streamed for hashing. The dry-run and the workflow copy step
  may exceed runtime limits on large recordings; no live-provider timing or load
  qualification is included.
- Rollback restores the exact original folder association, including unchanged
  public, organization, space, and mixed-owner folders. Its ancestor and space
  context must still match the preview; missing or changed context holds rollback.
  No folder access or sharing settings are rewritten. Changed edits, comments,
  metadata, or media also hold rollback rather than overwrite work.
- Recordings without upload rows require either valid legacy completion evidence
  or a current trusted ownership-preflight receipt. A distinct selected audio-level
  derivative must be independently decoded and match the base video stream.
- A later transfer of a recording with archived references outside its current
  owner prefix is held. This path does not rewrite immutable processing provenance.
- Retaining objects does not revoke existing signed URLs. Storage lifecycle rules
  and out-of-band object mutations remain external to the database transaction;
  this path does not lock an S3 prefix or provide immutable object versions.
- Verification includes synthetic adapters plus isolated MySQL/local-workflow and
  official-source MinIO integration runs described below. Other providers and
  deployed workflow execution still need qualification before operational use.
  There are no schema migrations.

## Standalone preflight trust contract

`prepareRecordingOwnershipPreflight` is an authenticated manager action. It checks
organization/target membership, storage/folder eligibility, quiescent state, complete
active-reference coverage, and stable source HEAD inventories, then rechecks access
and the database snapshot. It returns a signed read challenge, not a completion
receipt. No upload row, processing job, webhook, or storage write is created.

An existing trusted internal operator runs the Linux/Bun 1.4+ command:

```sh
bun scripts/recording-ownership-preflight.ts REQUEST WORK_DIRECTORY RECEIPT --cleanup
```

The command requires the existing `MEDIA_SERVER_WEBHOOK_SECRET` and an independently
trusted comma-separated `OWNERSHIP_PREFLIGHT_STORAGE_ORIGINS` allowlist of exact HTTPS
origins. Do not derive this allowlist from a caller manifest. Use the existing secret
in the existing trusted operational environment; this feature creates no credentials,
service, signing key, or infrastructure. Neither variable should be placed in shell
history, request files, receipts, or logs. The secret is removed from the process
environment before child processes launch and is not passed in downloader or
decoder arguments. This is inheritance hygiene, not OS isolation: a compromised
decoder running under the same OS user may access the orchestrator or its secret.
The existing host, operator account, and toolchain must be trusted. Signed GET URLs
are confidential read capabilities; keep the request and private working directory
restricted.

Request, receipt, and local checkpoint MACs use separate domains. Only the local
completed-verification path signs a receipt; no action seals arbitrary caller pass
claims. This authenticates an existing trusted verifier possessing the existing
secret, not hardware-attested execution. A caller without that secret cannot forge
a receipt or turn a signed challenge/checkpoint into one. Secret compromise or a
modified trusted worker is outside this trust model.

The signed challenge binds the full recording snapshot, organization, target,
destination, exact object HEAD/version manifest, required media assets, selected
playable output, and expiry. The worker checks that authorization and binding before
reads. It cannot observe later membership or database changes while offline from the
application: application acceptance and locked publication revalidate current access,
full snapshot, complete prefix inventory, references, receipt binding, and expiry.
A challenge is valid for at most 24 hours; receipts for at most one hour and never
past the challenge expiry. Revocation is enforced at application acceptance, not by
revoking already issued GET URLs. Expired applied-proof attempts must be cancelled
and re-preflighted; verified destination copies remain safely reusable.

Downloads use only GET, exact ranges, If-Match, version-pinned URLs when available,
and current-version checks before and after verification. Every DNS result must be
public, connections pin the checked address, origins must match the independent
allowlist, and redirects are rejected. No signed URL or provider response is logged.
All source-prefix bytes are hashed, including ancillary/unreferenced media. Base,
selected audio derivative, active raw, and edit MP4 sources receive full EOF decode.
Extra tracks, unsupported containers, malformed/truncated input, missing audio in an
audio derivative, timeline gaps, and different decoded video streams hold the receipt.
Ancillary images, captions, and media comments are byte/reference verified, not decoded.
Archived JSON/reference validation still runs in the application before acceptance.

The worker limits input to 64 GiB and 10,000 objects, each range to 8 MiB, total range
count to 65,536, network bytes to a bounded retry allowance, and wall time to 24 hours.
It checks available disk before each download. FFprobe is limited to 30 CPU seconds,
512 MiB address space, and 128 KiB output; FFmpeg to 2 GiB address space, one thread,
24 CPU hours, and the remaining worker wall-time budget. Preflight has no
progress-stall timer; the shared decoder enables that timer only with packet proof,
which this path does not supply. Decoded bytes are streamed into hashes;
frames, decoder diagnostics, source paths, and URLs do not enter output receipts.
Linux `flock`, `prlimit`, FFmpeg, and FFprobe must be available in the trusted image.

A private authenticated checkpoint is fsynced at completed download chunks and
completed asset decodes. Retries validate cached chunks and full file hashes before
reuse. Interrupted decodes restart the entire asset; they never claim proof from a
seeked suffix. A refreshed challenge with the same snapshot/manifest/asset binding
can renew expired GET URLs without losing progress. A changed binding is held.
The process lock excludes concurrent workers and is released by process exit.

`--cleanup` runs only after successfully writing a new receipt file. It takes the
same lock, validates the authenticated checkpoint, rejects links and unexpected
file types, and removes only known cache files and that checkpoint. Unrelated files,
the request, receipt, lock file, work directory, and every remote original remain.
Failures retain the cache for retry. No recursive remote or local deletion occurs.

A successful preflight proves the current stored assets decode and match the bound
manifest. It cannot prove that historically lost capture bytes once existed or that
a valid shorter replacement was the complete original capture. Source provenance is
not fabricated. Copy/readback still uses the existing transfer workflow and can exceed
deployed runtime limits; production timing and public-storage preflight qualification are not included.

## Minimum trusted operator environment

The repository-root media-server image (`apps/media-server/Dockerfile`, used by
the existing service configuration) includes Bun, FFmpeg, FFprobe, `flock`, `prlimit`,
the reviewed worker and its shared validator. Its normal service command, health
check and ports are unchanged. It exposes the following operator command:

```sh
recording-ownership-preflight REQUEST WORK_DIRECTORY RECEIPT --cleanup
```

This invokes Bun with dotenv loading disabled and resolves the packaged source
independently of the working directory. The `operator` build stage runs focused
executable packaging tests; the default `release` stage also runs the existing
media-server checks. The standalone Compose image uses a service-only build
context and is unchanged; it does not include this operator command.

Alternatively use an existing trusted Linux operator environment with the reviewed
checkout and installed dependencies, Bun 1.4+, FFmpeg, FFprobe, `flock`, and `prlimit`.
The operator
must already be authorized to use the existing media-server verification secret;
do not copy it into a general workstation or create a new credential for this path.
A fresh challenge must come from an authorized organization manager and bind the
intended recording, target and destination. The operator separately supplies the
trusted exact storage-origin allowlist.

The local worker needs DNS and outbound HTTPS access to those approved public
storage origins, the challenge's scoped signed GET capabilities, a private writable
scratch directory with enough free space for the manifest and safety margin, and
permission to write a new receipt file. It does not need database credentials,
cloud-account credentials, bucket write/delete access, webhook access, or deployment
permissions. Application challenge preparation separately needs its existing
read-only database and storage listing/HEAD/presigning access. No credential values
are retrieved or transmitted as part of this review, and no operational execution
is authorized here.

## Isolated database and workflow qualification

Run `bun --no-env-file scripts/recording-ownership-integration.ts` from the reviewed
checkout to create a disposable MySQL test instance. The harness uses the pinned
official MySQL image, a dedicated bridge network, a random loopback-only database
port, tmpfs data, and generated test-only credentials. It limits the container to
1 GiB RAM, two CPUs and 256 processes. It supplies a clean test environment and
disables dotenv loading; it never reads production configuration or credentials.
The test suite is skipped unless the harness's explicit synthetic mode is enabled,
and rejects database URLs outside the loopback synthetic database/user boundary.

Schema DDL is generated from the repository's actual schema into the disposable
database. The suite exercises real transactions and row locks, concurrent admission
and workers, cancellation during copying, concurrent rollback, intervening edits,
and rollback after a later write fails. It also compiles the actual ownership
workflow and runs it through the installed local workflow runtime with in-process
step handlers and private temporary workflow state. Storage and authenticated user
resolution remain synthetic adapters in this suite; no real manager challenge is
issued. The harness removes its containers, network, tmpfs data, workflow scratch,
and any image it newly downloaded. It does not prune shared resources.

## Isolated S3 qualification

The storage suite uses a local build of the official MinIO community source release
`RELEASE.2025-10-15T17-29-55Z`, pinned to commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`. Upstream documents
[source-only community distribution](https://github.com/minio/minio#source-only-distribution).
Use the official source and its checked-in dependency
checksums; the qualified build used the checksum-verified Go 1.24.8 toolchain,
`CGO_ENABLED=0`, and `go build -trimpath -buildvcs=false -mod=readonly -tags kqueue
-ldflags="-s -w"`. Review the resulting static binary and compute its SHA-256.

Run `bun --no-env-file scripts/recording-ownership-storage-integration.ts
<reviewed-minio-binary> <sha256>`. The runner verifies the supplied binary's hash,
imports only that binary into a temporary image, and starts a non-root container
with a read-only root filesystem, tmpfs data, generated disposable credentials,
the same CPU/memory/process bounds as the database harness, and a random
loopback-only S3 port. No base image, registry login or alternate publisher is
needed. The caller is responsible for the binary's official-source provenance;
the hash check alone does not establish provenance. The runner removes its image,
container, network and temporary archive. Build/toolchain caches remain the
builder's responsibility.

The suite exercises the actual ownership adapter, storage wrapper and AWS SDK
against that local MinIO release. It covers real multipart copies across the
128 MiB part boundary, full-byte hashes with different multipart ETags,
create-only completion races, conflicting destinations, version-pinned GET/copy,
conditional range reads, identical-byte version replacements, and a lost
completion acknowledgement. It uses the SDK's normal retry behavior. Multipart
abort is best effort if transport failures exhaust those retries; bucket lifecycle
cleanup remains relevant for orphaned uploads.

The database/workflow and S3 suites are separate integration runs. These results
do not qualify every S3 provider, deployed workflow capacity, maximum-size
recordings, or the standalone preflight downloader against a real public endpoint.
Production preflight HTTPS/private-network guards remain unchanged; the storage
harness does not add a bypass to those guards.
