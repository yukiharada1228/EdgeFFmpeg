# Automatic checkpointed runner

`runCheckpointedMediaUnit` from `@edge-ffmpeg/runtime-cloudflare/checkpoints`
drives one component WorkUnit through the [coordinated checkpoint
journal](media-checkpoint-journal.md). Without it, every application writes the
same steps by hand: claim, restore latest state, process a bounded unit, prepare,
commit, repeat, finalize. The runner performs those steps and returns at a unit
budget, so a Worker can yield and a later invocation can continue. It does not
change the semantics of the coordinator, preparation, loading or final assembly.
[`MediaCheckpointWorkflow`](media-checkpoint-workflow.md) schedules those
invocations automatically as durable Workflow steps.
Design context: sections 11.4 (Checkpoint) and 11.5 (idempotency) of the
[detailed design](../architecture/detailed-development-design.md).

```ts
const journal = env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));
const result = await runCheckpointedMediaUnit({
  bucket: env.MEDIA_BUCKET, journal, identity, component,
  leaseMs: 30000, maxUnits: 8, maxObjectBytes: 1048576, // maxCommitAttempts?: 1..8 (default 3)
  signal, finalize: {filesystem: files, path: '/output/job.raw', maxWriteBytes: 65536},
  // resumeLease?: lease from an earlier yielded result (result.status.lease)
});
// result.outcome: 'finished' | 'yielded' | 'busy' | 'cancelled' | 'lease-lost' | 'aborted' | 'output-conflict'
// result.finalized: {bytes, revisions, outputChunks, existing?: true} | null
// result.conflict: MediaCheckpointOutputConflictError | null (set only for 'output-conflict')
```

Every limit, adapter and finalize option is checked before the first journal
call, so a bad configuration fails before any unit runs or commits:
`maxWriteBytes` (default 64 KiB) and `maxReadBytes` (default `maxWriteBytes`)
must be at most `maxObjectBytes`, the destination path must pass the same syntax
check as finalization, `filesystem` must provide `openWrite` and `openRead`
(`outputExists` optional), `overwrite` must be boolean and `patches` a function,
with `maxPatches` 1..256 and `maxPatchBytes` 1..65536. The finalize options are
snapshotted at the call. `preflightCheckpointedMediaUnit(options)` performs the
same checks without I/O.

`journal` is the structural `MediaCheckpointJournal` interface
(`initialize/claim/heartbeat/status/commit`), satisfied by a
`MediaCheckpointCoordinator` stub or by a test fake. The runner never calls
`cancel()`. The component adapter supplies:

- `create()`: fresh state at revision 0. `restore(bytes, head)` rebuilds state
  from committed state bytes.
- `process(state, head, signal)`: consumes exactly one bounded input unit from
  `head.inputPosition`. It returns `{output, inputPosition, finished}`, where
  `output` is the bytes the unit emitted (empty or `null` when it emitted none).
- `serialize(state)`: returns the state bytes for the transition.
- `verify(state, position)`: returns `true` only when the component's own
  counters match that journal position.
- `dispose(state)` (optional): always called once a state exists.

## Control flow

1. `initialize(identity)`. A finished journal goes straight to finalization. A
   cancelled one returns `cancelled`. Neither claims a lease or creates state.
2. `claim(leaseMs)`. If there is no claim, the runner reads `status()`. An active
   owner gives `busy`, and a terminal journal is handled as in step 1. The claim's
   status must match the run's identity, contain exactly `revision` commits whose
   last entry equals the head positions, and hold the claimed lease. With
   `resumeLease`, the runner first renews that lease with `heartbeat` and reads
   `status()`; if the journal still names it, the invocation continues under it
   without claiming. A refused (expired, stolen or fenced) lease falls back to
   `claim`, and a terminal journal is handled as in step 1.
3. Restore. With commits present, the runner calls `loadMediaCheckpoint` on the
   **latest committed descriptor only**, which checks the ETag, version, size
   and SHA-256 pins. It then calls `restore`. With no commits it calls `create`.
   `verify(state, head)` must return `true` before any unit runs. Tampered state
   fails before `restore` is called.
4. Per unit: if the signal is aborted, return `aborted`. If the budget is reached,
   return `yielded`. Otherwise call `heartbeat`. A `null` heartbeat reads
   `status()`: a cancelled journal returns `cancelled`, a journal another owner
   finished goes to finalization (step 6), and anything else is `lease-lost`.
   Then `process` runs. The runner checks that the reported input position is canonical and does
   not move backwards. A nonterminal unit must also advance input or output, and
   output must fit `maxObjectBytes`. The output position is the previous byte
   position plus the emitted length. `verify(state, next)` runs before
   `serialize`, so a component whose counters drift from the positions it
   reports commits nothing. These component contract violations (counters that
   disagree after restore or after a unit, a unit that does not advance, a
   malformed unit) throw `TypeError`, so a scheduler can treat them as
   deterministic.
5. `prepareMediaCheckpoint` stages immutable objects under the lease's private
   prefix. `commit` follows. If the commit fails, the runner first retries the
   **identical descriptor with the original lease**. The journal treats that as
   an exact replay. Each later failure reads `status()`:
   - If the journal already contains the descriptor, the commit is confirmed.
   - If the journal is cancelled, the lease is gone, or another owner committed
     that revision, the runner stops and reports `cancelled`, `lease-lost`, or
     goes to finalization when the journal finished.
   - Otherwise the runner retries, up to `maxCommitAttempts`.

   An unconfirmed commit is rethrown. When the journal inspection also failed,
   the runner throws an `AggregateError`. Nothing is rolled back. Staged objects
   are kept, and the next owner recomputes from the last committed revision.
6. After the terminal commit, and on every later invocation of a finished
   journal, `finalizeMediaCheckpointOutput` runs with the finished status, the
   same `maxObjectBytes` and the signal. The runner has no existence shortcut of
   its own. `finished` is reported only with a verified result: either the
   destination was published now, or an existing no-clobber destination matched
   the journal output in size and SHA-256 (`finalized.existing: true`, no writer
   opened). A differing destination is returned as `output-conflict` with the
   finished `status` and the `MediaCheckpointOutputConflictError` in `conflict`;
   it is never overwritten. Other finalization failures are rethrown, and a
   later invocation retries finalization from the finished journal. An abort
   observed before finalization returns `aborted` with the finished status.

The runner renews the lease before every unit but does not renew it during a
unit. One unit, including its input reads, `serialize`, preparation and commit,
must finish within `leaseMs`. The coordinator has no lease release operation,
so the runner cannot release the lease when it yields: a later invocation
without `resumeLease` sees `busy` until that lease expires. The owner that
yielded can pass `result.status.lease` as `resumeLease` to continue at once; the
Workflow driver does this between steps. Pass it only after every invocation
that used the lease has settled (returned or thrown). Heartbeat and commit
compare only the generation and token, so the coordinator cannot tell two live
holders of one lease apart, and both would heartbeat and commit. A resumed lease
also reuses that owner's object prefix: a revision it prepared but never
committed is prepared again and must serialize byte-identically, otherwise
preparation fails with an immutable object conflict. Abort is checked at unit boundaries,
before preparation, before finalization and inside `process` through the
signal. A commit that is already in flight is not abandoned. In-memory state is
dropped on every non-finished return. Only committed journal state carries
progress between invocations.

## Workerd acceptance

[`media-checkpoint-runner.test.ts`](../../tests/workers/media-checkpoint-runner.test.ts)
and its [fixture](../../tests/workers/media-checkpoint-runner-fixture.ts) use
the real `MediaCheckpointCoordinator` (SQLite Durable Object) and R2 in local
workerd. The component is the audio FIFO from `createAudioReframeState`
(`asetnsamples=n=3`, both padding policies). Its input is a 23-sample stereo
s16le 8 kHz object in R2, pinned by ETag and a SHA-256 fingerprint in the
identity. Each unit is a 5-sample ranged R2 read. The state blob combines the
FIFO checkpoint with that unit's emitted frame metadata, so observed PTS are
committed atomically with the output. `verify` compares the FIFO's `received`
counter with the input position, and its `emitted` counter × 4 with the byte
position. The test proceeds as follows:

1. The first invocation commits 2 units and yields. The runtime is destroyed. A
   new runtime reports `busy` until the lease expires.
2. A fresh runtime restores revision 2. One commit reply is dropped after the
   journal applied it. The runner replays the identical descriptor once
   (`commitRetries: 1`), and the journal has 3 revisions.
3. After another restart, an invocation commits revision 4. Every later journal
   call then fails, simulating a runtime killed before the acknowledgement. In a
   new runtime the journal shows revision 4. The run reports `busy`, then after
   expiry it resumes, commits the terminal revision and publishes
   `final/runner-<pad>.raw` through staged R2 output, leaving no staging objects.
4. Four distinct lease owners appear in the five committed revisions. A replay
   returns `finished` with `finalized.existing: true` after verifying the
   published bytes against the journal, opens no staging and leaves the
   published version unchanged.
5. The published object matches the pinned Native FFmpeg
   (`aformat=s16p,asetnsamples=n=3:p=<pad>,asetpts=PTS+123`, `pcm_s16le`) byte
   for byte: 92 bytes unpadded, 96 bytes padded. The committed frame sample
   counts and PTS equal Native `framecrc`.

[Unit tests](../../tests/unit/media-checkpoint-runner.test.ts) use an in-memory
journal built from the pure `state.ts` transitions and a fake R2 bucket. They
cover:

- the budget, busy state, resume and finalize-once order
- a heartbeat before every unit
- an identical-descriptor replay after a lost reply, and confirmation through
  `status()` when replies keep failing
- an unconfirmed commit that is rethrown, after which a later owner recomputes
  the unit (orphaned staged objects are kept)
- an `AggregateError` when the commit and the inspection both fail
- cancellation during a unit and between units
- lease theft during a unit and at heartbeat, and a heartbeat refused because
  another owner finished the journal, which finalizes (verifies) instead of
  reporting `lease-lost`
- abort before the run and during `process`
- restore counter mismatch and tampered committed state
- non-advancing, drifting, malformed and oversized units (contract violations
  are `TypeError`)
- empty EOF as a null output pointer
- limit, adapter and resume-lease validation before any journal call
- finalize preflight (path syntax, `openWrite`/`openRead`/`outputExists`,
  `overwrite`, `patches`, write/read limits against `maxObjectBytes`, patch
  limits) before any journal call, unit or R2 write, and the option snapshot
- replay verification of an identical destination (`existing: true`), and
  `output-conflict` for a different size or same-size different bytes, with no
  writer opened and the destination untouched
- rethrown finalization failures and abort before finalization
- `resumeLease` continuation without waiting for expiry, and fallback to `claim`
  when the lease expired, was stolen or the journal was cancelled

## Not implemented

- Lease renewal during a long unit, and an explicit release on yield (the
  coordinator has no release operation; `resumeLease` covers the same owner
  only). Scheduling by alarm or queue; Workflow scheduling is
  [`MediaCheckpointWorkflow`](media-checkpoint-workflow.md).
- Integration with the whole-command job/Workflow runners or the general media
  pipeline. The runner continues a single component with an explicit state
  codec. It does not checkpoint arbitrary graphs, codecs or Wasm, and muxer state
  only when the component serializes it itself, as the
  [WAV mux](wav-mux-checkpoints.md) and
  [checkpointed audio pipeline](checkpointed-audio-pipeline.md) components do.
- Restore loads the committed output chunk alongside the state, because there is
  no state-only loader. The extra read is bounded by `maxObjectBytes`.
- Recovery of staging retained after an uncertain destination commit.
- Automatic garbage collection of staged objects from unconfirmed or stale
  attempts, and journals longer than 256 revisions. Explicit collection for one
  identity is [`collectMediaCheckpointOrphans`](media-checkpoint-collection.md);
  the runner never calls it.
- Final assembly is byte concatenation with optional fixed-length header patches
  derived from the terminal committed state (see
  [WAV mux checkpoints](wav-mux-checkpoints.md)). Remux, index rewriting and
  multiple outputs are not supported.

Byte limits bound individual objects, not total heap or CPU. The workerd
acceptance on this page covers the audio FIFO component only; the
[WAV mux](wav-mux-checkpoints.md#verified-evidence) and
[checkpointed audio pipeline](checkpointed-audio-pipeline.md#verified-evidence)
acceptances drive their components through the same runner in local workerd. It
does not establish production deployment readiness or full FFmpeg compatibility.
