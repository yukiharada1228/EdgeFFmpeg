# Checkpoint orphan collection

`collectMediaCheckpointOrphans` from `@edge-ffmpeg/runtime-cloudflare/checkpoints`
deletes R2 attempt objects that the [coordinated checkpoint
journal](media-checkpoint-journal.md) can never reference. Preparation stages
immutable `state.bin`/`output.bin` objects under a lease-private prefix before
`commit()`. A lost acknowledgement, a failed preparation, a stale owner or an
unconfirmed commit therefore leaves objects behind, and the
[runner](media-checkpoint-runner.md) deliberately never rolls them back. This
collector is the explicit cleanup step for one job/WorkUnit identity. It never
changes what a journal references (design section 11.5, idempotency).

```ts
const journal = env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));
const report = await collectMediaCheckpointOrphans({
  bucket: env.MEDIA_BUCKET,
  journal: {status: async () => await journal.status() as MediaCheckpointStatus | null},
  identity,
  dryRun: false,            // true: report the plan, delete nothing
  maxObjects: 1024,         // listed keys per run, 1..4096
  maxDeletes: 1024,         // deletions per run, 1..4096 (default maxObjects)
  pageSize: 1000,           // R2 list limit and delete batch size, 1..1000
  maxPages: 16,             // list calls per run, 1..1024
  // startAfter: previous.next, signal,
});
// report.outcome: 'collected' | 'live-lease' | 'missing-journal' | 'aborted'
// A failure after deletion began throws MediaCheckpointCollectionError whose
// .report (outcome 'failed') records what this run deleted.
```

`journal` only needs `status()`. The collector never claims, heartbeats,
commits or cancels.

## Safety rule

The collector lists `checkpoints/<namespace>/`, where `<namespace>` is
`mediaCheckpointCoordinatorName(identity)`. It deletes a listed key only when
every one of these holds for the latest journal read:

1. The key has the exact attempt layout
   `<generation>/<token>/revision-<1..256>/(state|output).bin`, which is the
   output of `mediaCheckpointObjectPrefix`. Any other key under the prefix is
   kept as `unrecognized`. This covers notes, malformed generations, revisions
   above 256, other file names and `.`/`..` segments.
2. The listed object carries the `edgeCheckpointSha256` custom metadata
   (64 lowercase hex digits) that `prepareMediaCheckpoint` writes with every
   attempt object. Listing requests `include: ['customMetadata']`. An
   attempt-shaped key without that marker is kept as `unrecognized`, for
   example a VFS output written through `createR2FileSystem`, which marks
   objects with `edgeffmpegTransaction` only.
3. No journal commit references the key, as either the `state` or the `output`
   pointer.
4. No lease is live. The journal phase is not `running`. The collector treats
   any lease reported by `status()` as live and does not consult its own clock.
5. The key's attempt is fenced:
   - `finished` or `cancelled` (reason `terminal`). Terminal phases never change.
     `claim()` requires `ready`, and `commit()` requires a valid lease, so the
     set of commits is frozen. An exact original-committer replay returns the
     unchanged journal and adds no reference.
   - `ready` with at least one commit, and the key's generation is at most the
     highest generation among the commit keys (reason `fenced`).
     `commitMediaCheckpoint` only accepts keys under the committing lease's own
     prefix, so a commit key proves that its generation once held the lease.
     The generation counter never decreases. With no current lease, every future
     claim gets a strictly higher generation. No lease at or below that
     generation can become current again. The DO `status()` persists lease
     expiry, so this fence is durable.

Everything else is kept: `committed` for referenced keys, `live-lease` when a
lease is live, and `unfenced` for keys whose generation is above the last
committer of a `ready` journal or that belong to a journal without commits.
`status()` does not expose the coordinator's generation counter. An expired
owner above the last committer therefore cannot be proven fenced while the
journal can still be claimed. Its objects become collectable once the journal
is terminal or a higher generation commits.

## Races and re-reads

The run reads the journal three times:

- **Before listing.** A missing journal returns `missing-journal`. A live lease
  returns `live-lease`. In both cases nothing is listed.
- **After listing.** Keys are classified against this read, so a claim or
  commit that raced the listing is visible. A live lease returns `live-lease`
  without deleting anything.
- **Immediately before every delete batch.** If a live lease appears, the
  remaining candidates are kept as `live-lease` and the run stops. Each batch is
  reclassified against this read, and the reason (`terminal` or `fenced`) comes
  from it.

Every read is validated before use:

- identity equality
- phase/lease agreement
- `commits.length === revision`
- canonical positions
- every commit's keys within this prefix's attempt layout, with state and
  output from the same attempt and revision

Successive reads must be monotonic. Earlier commits must stay byte-identical,
the commit count must not shrink, and a terminal phase and its commits must not
change. Anything else throws `Checkpoint journal regressed during collection`
before any further deletion, wrapped as described below once deletion began.

The Workers binding `R2Bucket.delete(keys: string | string[])` in
`@cloudflare/workers-types` takes no conditions, so deletes are unconditional.
This is sound because eligibility is a permanent property of the key, not of
an object version. Once a key satisfies the rule against one consistent journal
read, no later commit can reference it. A fenced owner that re-stages the same
key after listing writes another unreferenced version, which a later run removes.
A delete batch that has already been sent is not abandoned. Deleting a missing
key is a no-op, so concurrent collectors and reruns are idempotent.

Failures before the delete phase throw the original error and delete nothing.
These include an invalid page and an inconsistent or regressed post-listing
read. Once a real run reaches its first pre-delete read, any failure throws
`MediaCheckpointCollectionError`. This covers a regressed or inconsistent
journal read and a rejected `bucket.delete`. The error carries:

- the message `Checkpoint collection stopped after deleting <n> objects: <cause>`
- `cause`, the original error
- `report`, with outcome `failed`

The report lists every key deleted by earlier batches as `deleted`. The failed
batch and every remaining candidate are `skipped` with reason `failed`. A
rejected batch may have been applied partly or completely, so these keys may
already be gone. `report.next` resumes before the first of them, so a rerun
from it finishes the deletion idempotently.

## Bounds, continuation and reports

All limits are validated before the identity is hashed or any provider is
called. Invalid limits throw `RangeError`. An invalid bucket, journal or
`dryRun` throws `TypeError`. A `startAfter` key outside the prefix also throws
`TypeError`: it must start with the prefix, have no `.`/`..` segment, no
backslash or NUL, and at most 1024 characters.

Each list call requests `min(pageSize, maxObjects - listed)` keys and passes the
provider cursor on later pages. Listing stops at `maxObjects` or `maxPages`. A
page is rejected, and nothing is deleted, when it:

- exceeds the requested limit
- is truncated without a cursor or objects
- repeats a key
- returns a key outside the prefix

A partial window is safe because every decision is made per listed key.

Every listed key appears exactly once in the report:

- `deleted`: `{key, reason: 'terminal' | 'fenced'}`
- `kept`: `{key, reason: 'committed' | 'live-lease' | 'unfenced' | 'unrecognized'}`
- `skipped`: `{key, reason: 'dry-run' | 'max-deletes' | 'aborted' | 'failed'}`.
  These keys were not deleted by this run. `dry-run` and `max-deletes` apply
  only to eligible keys. `aborted` keys may be unclassified when abort was
  observed before the post-listing read. `failed` keys appear only in a
  `MediaCheckpointCollectionError` report.

The report also carries `outcome`, the latest `phase`, `dryRun`, `prefix`,
`pages`, `listed` and `next`.

`report.next` is the `startAfter` that continues one pass over the prefix. A
listed key is settled when it was deleted, planned as `dry-run`, or kept as
`committed`, `unfenced` or `unrecognized`. It is unsettled when it was skipped
as `max-deletes`, `aborted` or `failed`, or kept as `live-lease`. `next` is:

- the listed key just before the first unsettled key, when one exists. If the
  first unsettled key opens the window, `next` is the window's own
  `startAfter`, or `prefix` when the window began at the start.
  `startAfter: prefix` lists the whole prefix, so a continued run revisits
  every unsettled key.
- the last listed key, when every listed key is settled but a bound stopped
  listing. Without it, a window full of committed keys would never make
  progress.
- the run's own `startAfter`, or `prefix`, when the run listed nothing: abort
  before listing, an initial `live-lease`, or `missing-journal`.
- `null` only when the listing reached the end of the prefix and every listed
  key was settled.

Continue the pass with `startAfter: report.next` while `outcome` is
`collected` and `next` is not `null`. On `live-lease`, `aborted`, `failed` or
`missing-journal`, retry later from the same `next`. `maxDeletes` is at least
1, so a `collected` window that leaves `max-deletes` keys has deleted at least
one key before them, and a pass always progresses. `unfenced` keys are settled
for the pass. A later pass collects them once the journal is terminal or a
higher generation commits.

A dry run lists, classifies and applies `maxDeletes` like a real run with the
same options. The first `maxDeletes` eligible keys are `dry-run`, the rest are
`max-deletes`, and `next` is the same as the real run's. The dry run skips the
pre-delete read and every delete.

`AbortSignal` is checked:

- before the first read
- before every list call
- before classification
- before every delete batch

## Deployment preconditions

The collector never deletes the final output destination, finalization staging
or another journal's objects when these hold:

- **One coordinator namespace owns `checkpoints/` in a bucket.** The prefix
  hashes only `[jobId, workUnitId]`, and the collector treats this identity's
  one journal as the only referrer of everything under it. Two
  `MediaCheckpointCoordinator` namespaces can share a bucket, such as two
  Workers or environments with their own `CHECKPOINTS` binding. If both run the
  same job/WorkUnit, a terminal journal in one deletes attempt objects that the
  other journal still references. Random lease tokens prevent key collisions
  during preparation, but collection turns the shared prefix into data loss.
  Give each coordinator namespace its own bucket, or never run the collector
  against a shared one. The collector cannot detect this case, because both
  namespaces write identical markers.
- **Output mounts and staging prefixes stay outside `checkpoints/`.** The
  final destination and finalization staging are then outside this prefix.
  The digest-marker rule also keeps a VFS object written at an attempt-shaped
  key inside the prefix. That check reads the listed version, and R2 deletes
  are unconditional. It therefore does not cover a VFS write that replaces an
  attempt object between listing and deletion, so the precondition is still
  required.

## Verification

[Unit tests](../../tests/unit/media-checkpoint-collect.test.ts) use the pure
`state.ts` transitions as the journal. They use a fake R2 bucket with
conditional puts, lexicographic prefix listing, opaque cursors, `startAfter`,
listed custom metadata and batch delete with injected failures. Objects are staged through the real `prepareMediaCheckpoint`. The
tests cover:

- A finished journal: two orphan attempts are deleted, one of them state-only
  after a failed output put. Committed objects still pass `loadMediaCheckpoint`.
  Final output, staging, another identity, traversal-shaped keys and
  attempt-shaped keys without a valid digest marker are untouched.
- A live lease: there are no list or delete calls. A `ready` journal deletes only
  generations up to the last committer, and a journal without commits keeps
  everything.
- Pagination: windows of 5 keys with pages of 2 keys. Each delete batch is
  preceded by its own journal read. Runs continue through `next`/`startAfter`
  until the listing ends, and `maxPages` stops listing.
- Races: a claim during listing, and a claim plus commit between the
  post-listing and pre-delete reads, both stop the run. A racing commit that
  finishes the journal turns the reason into `terminal`. Objects committed
  during listing are kept as `committed`. Regressed journals throw before
  deleting: a lost commit, a changed terminal phase or a rewritten earlier
  commit.
- `maxDeletes`, invalid limits/types/identity (including `maxDeletes: 0`), a
  missing journal, malformed or escaping pages and inconsistent journals
  (foreign or mixed commit keys, phase and lease disagreement, identity
  mismatch, length mismatch).
- Dry run versus a real run, unbounded and with `maxDeletes: 1`. The plan's
  `dry-run`/`max-deletes` split, `kept` and `next` equal the real run's.
- Abort before work, during listing and between delete batches, with the
  `next` each one returns, and cancelled-journal collection.
- `startAfter` traversal rejection.
- Continuation: windows of 3 keys with `maxDeletes: 1` resume before the
  skipped key and delete every orphan in one pass.
- Failures in the delete phase: a batch that throws after partly applying, a
  later batch whose acknowledgement is lost, and a journal that becomes
  inconsistent at a later pre-delete read. Each throws
  `MediaCheckpointCollectionError`, which reports earlier deletions and marks
  the rest `failed`. A rerun from `next` finishes idempotently.

[Workerd acceptance](../../tests/workers/media-checkpoint-collect.test.ts) runs
the [fixture](../../tests/workers/media-checkpoint-collect-fixture.ts) with the
real `MediaCheckpointCoordinator` (SQLite Durable Object) and R2 in local
workerd ([configuration](../../tests/workers/media-checkpoint-collect.wrangler.jsonc)).
The component is the audio FIFO (`asetnsamples=n=3`, both padding policies).
For each identity:

1. Owner A commits revision 1, and its commit acknowledgement is dropped. A then
   stages revision 2 through an injected lost output-put acknowledgement, which
   is reconciled to the same object and version, and never commits it.
   Collection under A's live lease lists nothing.
2. After expiry, a dry run plans exactly A's revision-2 objects.
3. Owner B stages revision-2 state, then its output put fails. Owner C prepares
   fully and its lease expires. A real collection on the `ready` journal deletes
   A's objects as `fenced` and keeps B's and C's as `unfenced`.
4. Owner D (generation 4) claims. C's stale commit is rejected, and D's live
   lease blocks collection. D commits the terminal revision. A non-attempt
   `notes.txt` and an attempt-shaped `5/vfs/revision-1/output.bin` without the
   digest marker are added.
5. After a full runtime restart, a `maxDeletes=1`, `pageSize=1` run (9 pages)
   deletes one orphan and returns `next` just before the first skipped key. A
   run continued from that `next` deletes the other two as `terminal`. Exactly
   the four committed objects and the two unrecognized keys remain. The other
   identity's keys are unchanged.
6. `/load` verifies every committed state and output object, and its bytes,
   like the published `finalizeMediaCheckpointOutput` result, match the pinned
   Native FFmpeg `aformat=s16p,asetnsamples=n=3:p=<pad>,asetpts=PTS+123`
   `pcm_s16le` output: 32 bytes unpadded, 36 bytes padded. Staging is empty.
7. A replayed collection deletes nothing, keeps the same keys and leaves the
   published version unchanged.

## Not implemented

- Collection of a `ready` journal above its last committer's generation. This
  needs a read-only coordinator query for the generation counter, which
  `status()` does not provide.
- Scheduling: alarm, queue, Workflow step or post-finalize hook. Callers invoke
  the collector explicitly. There is no sweep across identities.
- Deleting referenced history (for example historical state objects after
  finalization) or the journal itself. Referenced objects are retained for as
  long as the journal exists.
- Cleanup of R2 output staging retained after an uncertain destination commit.
  That remains with `recoverPublishedR2Output`.

This covers orphan collection for coordinator-prepared attempt objects in local
workerd. It does not establish production deployment readiness or full FFmpeg
compatibility.
