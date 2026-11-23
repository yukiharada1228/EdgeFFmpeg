# Coordinated component checkpoints and output chunks

`MediaCheckpointCoordinator` publishes component state and its corresponding
output progress together in one SQLite Durable Object journal update. This is a
separate component-continuation API; whole-command job/Workflow retries retain
their existing replay behavior.

Import portable helpers/types from
`@edge-ffmpeg/runtime-cloudflare/checkpoints` and export the Worker-only class from
`@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object`. The
[local configuration](../../tests/workers/media-checkpoint.wrangler.jsonc) and
[actual fixture](../../tests/workers/media-checkpoint-fixture.ts) show the
`CHECKPOINTS` SQLite namespace and `MEDIA_BUCKET` R2 binding.

```ts
const name = await mediaCheckpointCoordinatorName(identity);
const journal = env.CHECKPOINTS.getByName(name);
await journal.initialize(identity);
const claim = await journal.claim(30000);
if (!claim) return; // Another active owner or a terminal journal.

// Restore the latest committed state, if any, then process a bounded input unit.
const descriptor = await prepareMediaCheckpoint(
  env.MEDIA_BUCKET, identity, claim.lease,
  {revision: claim.status.revision + 1,
   inputPosition: nextInputPosition.toString(),
   outputPosition: nextOutputBytePosition.toString(),
   state: serializedComponentState,
   output: outputChunk, // null when this transition emits no bytes.
   finished: reachedEOF},
);
const committed = await journal.commit(claim.lease, descriptor);
```

Identity contains job/WorkUnit IDs, graph hash, pinned input fingerprint and
implementation version. Namespace names hash job/WorkUnit identity; initialization
with changed graph/input/implementation is rejected. Every prepared descriptor
also carries the complete identity, so state prepared under different execution
settings cannot be committed to this journal.

## Publication and retry rules

Preparation writes immutable state/output objects beneath the current lease's
private generation/token/revision prefix. Conditional puts preserve existing
objects. A lost put response reconciles exact bounded bytes and digest metadata.
Prepared objects alone do not advance the logical output stream.

`commit()` verifies the active lease, next revision, immutable identity, ownership
prefix, monotonic positions and output byte count. One SQL transaction appends
both pointers and advances their positions. Output position is always bytes;
input position uses application-defined units consistently for that WorkUnit.
Zero emitted bytes require `output: null`. Nonterminal transitions must advance
input or output; terminal flush/empty EOF may retain the input position.

Retry the **same descriptor with its original lease** after an uncertain commit
response. An exact original-committer replay returns current journal state,
even after lease expiry, a later generation or a newer committed revision. It
never rewinds the journal or appends another copy. A changed descriptor or another
committer cannot impersonate that retry. Cancellation fences future commits;
finished journals cannot be claimed again. Clients renew active leases using
`heartbeat()` and recover expired leases using `claim()`; there is no background
queue/alarm scheduler in this API.

Only journal commits define the logical output. Consumers read committed
`status.commits` in revision order, not private staging keys.
`loadMediaCheckpoint` verifies exact R2 ETag/version/size pins and SHA-256 before
returning state or output bytes. The application must also verify component
counters/configuration against journal positions before resuming. The audio FIFO
fixture checks received samples and emitted byte position explicitly.

This is atomic publication of references in SQLite, not a distributed R2/SQLite
transaction. Stale attempts can leave unreachable R2 objects; uncertain objects
are retained and garbage collection is not automated; the explicit
[orphan collector](media-checkpoint-collection.md) deletes attempt objects a
journal can never reference. Trusted application code
must use preparation and pin validation correctly. The coordinator does not
fetch objects or interpret arbitrary component codecs, and its bindings are
capabilities rather than an authorization boundary.

## Final byte assembly

`finalizeMediaCheckpointOutput` concatenates the committed output chunks of a
finished journal, in revision order, into one destination opened through an
atomic `VirtualFileSystem` writer such as the staged R2 output of
`createR2FileSystem`:

```ts
const status = await journal.status();
if (!status) throw Error('Missing journal');
const files = createR2FileSystem({bucket: env.MEDIA_BUCKET, mounts: {'/output': 'final'},
  maxReadBytes: 1024, output: {writableMounts: ['/output'], stagingPrefix: 'final-stage',
  partBytes: 5242880, maxWriteBytes: 65536, maxOutputBytes: 1048576}});
const result = await finalizeMediaCheckpointOutput({
  bucket: env.MEDIA_BUCKET, status, filesystem: files, path: '/output/job.raw',
  maxObjectBytes: 8388608, maxWriteBytes: 65536, signal, // overwrite?: boolean
  maxReadBytes: 1024, // upper existing-destination read slice; a readAt RangeError halves it
  // patches?: ({descriptor, state, bytes}) => [{offset, bytes}], maxPatches?, maxPatchBytes?
});
// result: {bytes: total output bigint, revisions, outputChunks, existing?: true}
```

Before opening a destination or reading R2 it snapshots the status and requires
`phase: 'finished'`, no lease, contiguous revisions with the journal identity,
exactly one terminal commit, monotonic positions, per-revision output sizes equal
to output deltas, head positions equal to the last commit, object keys beneath
this journal's attempt prefixes and every chunk within `maxObjectBytes`. Invalid
destinations and byte limits are also rejected up front. Only output objects are
read (never historical state), one at a time, each through the same ETag,
version, size and SHA-256 pins as `loadMediaCheckpointOutput`; writes are split
into `maxWriteBytes` slices and the next object is read only after the previous
slices complete. The optional `patches` callback derives bounded header
rewrites from the pinned terminal state loaded through `loadMediaCheckpoint`.
They are validated (count, total bytes, inside the output, non-overlapping)
before any destination is probed or opened, then applied to each chunk as it
streams; see [WAV mux checkpoints](wav-mux-checkpoints.md#final-assembly-with-patches).

Without `overwrite: true`, `outputExists(path, signal, {overwrite: false})` is
probed first. An existing destination is verified, not reopened: its size and a
streamed SHA-256 are compared with the assembled (patched) journal output.
Identical content returns the normal result with `existing: true`; different
content throws `MediaCheckpointOutputConflictError`. Neither creates a writer or
staging, so a replay after publication leaves the published object untouched.
The probe repeats before commit, and the R2 adapter still publishes with a
conditional put. With `overwrite: true` there is no probe, and the existing
object is replaced only after every chunk has been verified and staged. Details:
[no-clobber destination contract](wav-mux-checkpoints.md#no-clobber-destination-contract).

Any failure before commit (abort signal, missing, changed, truncated or
tampered chunk, destination write failure) aborts the writer once, which deletes
R2 staging; the destination is never published and an already published object
is not replaced. A destination appearing before commit also aborts the writer
once, and is then verified as above. A cleanup failure is reported as an
`AggregateError` with the primary error. Opening failures do not call abort.
Once `commit()` has been attempted, an uncertain R2 publish
(`R2CommitUncertainError`) keeps staging for `recoverPublishedR2Output`, and a
published-but-cleanup-failed result (`published: true`) is reported by the
adapter; both are rethrown without abort, and they are the only commit failures
that keep staging. Any other commit failure is definite for this writer: staging
is aborted once first, then the destination is probed again. If another writer
created it between the final existence check and the conditional put, it is a
lost no-clobber race and the destination is verified; if it is absent, the commit
error is rethrown. Abort is not observed while the adapter commit is in
progress.

This is byte concatenation with optional fixed-length range patches. It does not
remux, rewrite indexes, change the output length or validate media syntax, so the
committed chunks plus application-derived patches must form a valid stream for
the target (the fixture's raw s16le PCM; the WAV state's header rewrites). The workerd acceptance publishes both padding variants
to R2, matches Native raw PCM bytes, checks that an incomplete journal opens
nothing, that a replay without overwrite opens no writer, verifies the identical
published object and preserves its version, that a tampered chunk is rejected for both a new path and an
overwrite of the published path without leaving staging or changing that
version, and that a verified overwrite replaces the object with identical bytes.

## Bounds and verified scope

The journal admits at most256 revisions and8 KiB of metadata per descriptor.
Positions are canonical nonnegative integers of up to128 decimal digits. Lease
lengths range from10 ms to300 seconds. Object sizes are bounded to64 MiB, with
helper defaults of8 MiB per object; choose smaller limits and account for copies,
media buffers and runtime overhead within the application's resource budget.
These byte bounds do not certify total heap/CPU use. Platform SQL and object
semantics are documented in the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Actual local workerd acceptance prepares FIFO state/output privately, observes
revision0, commits with an injected lost HTTP acknowledgement, and verifies one
published revision after retry. Following a complete runtime restart and lease
recovery, it resumes from committed input/state and publishes the final chunk.
Stereo s16p8kHz `asetnsamples=n=3` with both padding policies matches Native raw
PCM and actual emitted PTS. Tests also exercise stale-owner rejection, old
revision replay after a newer revision, and independent state/output tampering.

This provides coordinated raw output chunks for a verified audio FIFO component
and their byte-level final assembly. Automatic scheduling inside the full media
pipeline, container-aware final assembly beyond fixed-length header patches
(remux, index rewriting), multi-output finalization, reconciliation of staging
retained after an uncertain commit, codec/Wasm state and
muxer state other than [WAV](wav-mux-checkpoints.md) continuation, other filter states and
automatic (scheduled) orphan cleanup remain open. No production deployment or full FFmpeg compatibility
certification is implied.
