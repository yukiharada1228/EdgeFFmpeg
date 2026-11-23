# Automatic checkpoint Workflow scheduling

`MediaCheckpointWorkflow` from `@edge-ffmpeg/runtime-cloudflare/checkpoints/workflow`
runs one checkpointed component WorkUnit to completion without application
looping. Each durable Workflow step performs one bounded
[`runCheckpointedMediaUnit`](media-checkpoint-runner.md) invocation against the
SQLite [checkpoint journal](media-checkpoint-journal.md). After the journal
finishes and the destination is published or verified, the Workflow writes an
immutable result manifest to R2. Design context: sections 9.3 (WorkUnit), 11.1
(Workflows), 11.4 (Checkpoint) and 11.5 (idempotency) of the
[detailed design](../architecture/detailed-development-design.md).

The steps run the media units themselves. This driver has no Queue hop between
the Workflow and the media Worker (11.1 shows one). The whole-command
[media Workflows](media-workflows.md) and
[durable jobs](durable-media-jobs.md) keep their Queue-based delivery.

## API

The runnable example is [the local fixture](../../tests/workers/media-checkpoint-workflow-fixture.ts),
with its [Wrangler configuration](../../tests/workers/media-checkpoint-workflow.wrangler.jsonc).
The Worker exports the coordinator and a subclass that returns its component
registry. Media code never travels in Workflow params.

```ts
import {buildMediaCheckpointWorkflowSpec,cancelMediaCheckpointWorkflow} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {MediaCheckpointWorkflow} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/workflow';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';

const registry = new Map([['asetnsamples', {
  implementationVersion: 'reframe-workflow-v1', // must equal the spec identity's
  bind: ({spec, bucket}) => ({component: fifoFor(spec, bucket), filesystem: outputFiles(bucket)}),
}]]);
export class FifoCheckpointWorkflow extends MediaCheckpointWorkflow {
  protected components() { return registry; }
}

// In a trusted application, after authorizing access to the input object:
const spec = await buildMediaCheckpointWorkflowSpec({
  bucket: env.MEDIA_BUCKET, workflowId: 'fifo-0', jobId: 'fifo-0', workUnitId: 'audio',
  component: 'asetnsamples', config: {n: 3, pad: 0, unitSamples: 5},
  implementationVersion: 'reframe-workflow-v1',
  inputs: [{key: 'inputs/fifo.s16le'}],
  output: {path: '/output/fifo-0.raw', maxWriteBytes: 1024, maxReadBytes: 1024}, // overwrite?: false
  policy: {leaseMs: 30000, unitsPerInvocation: 8, maxObjectBytes: 2048},
});
await env.CHECKPOINT_WORKFLOW.create({id: spec.workflowId, params: spec});
```

The environment provides `CHECKPOINTS` (the `MediaCheckpointCoordinator` SQLite
namespace) and `MEDIA_BUCKET`. `bind` runs in the validation step and in every
unit step. It receives the verified spec and the bucket, and returns the
`MediaCheckpointComponent`, the `VirtualFileSystem` that resolves
`spec.output.path`, and optional finalize `patches`/`maxPatches`/`maxPatchBytes`.
The component must read inputs through the pins in `spec.inputs`. Destination
digests use Workers' streaming `crypto.DigestStream`; validation fails with a
`TypeError` on a runtime without it.

## Specification and identity

The builder validates and snapshots every field before its first provider call.
It then pins each input once with `head` (key, ETag, version, size) and derives
the checkpoint identity:

- `graphHash` = SHA-256 of `{version, component, config}`. `config` is bounded
  JSON: finite numbers, strings up to 4096 characters, at most 64 identifier
  keys per object and 256 items per array, depth 8 and 16 KiB in total. Keys are
  sorted, so key order never changes identity.
- `inputFingerprint` = SHA-256 of the ordered input pins (1..16 distinct keys).
- `jobId`, `workUnitId` and `implementationVersion` come from the caller.

`specHash` covers the identity, component, config, pins, destination
(`path`, `overwrite`, `maxWriteBytes`, `maxReadBytes`) and policy. The
journal is keyed by job and WorkUnit identity only. Two specs that differ only in
scheduling policy or `workflowId` therefore drive the same journal. A different
config, input generation or implementation version is a different identity and
needs its own `jobId` or `workUnitId`: on a journal that already records another
identity for the same job and WorkUnit, the first unit step ends the instance
with `failed` (`identity conflicts with the journal`), without retries.
`verifyMediaCheckpointWorkflowSpec` recomputes all three hashes, and any
mismatch is rejected.

| Policy | Default | Bounds |
| --- | --- | --- |
| `leaseMs` | 30000 | 10..300000 |
| `unitsPerInvocation` (runner `maxUnits`) | 8 | 1..256 |
| `maxObjectBytes` | 8388608 | 1..67108864; also bounds `maxWriteBytes`/`maxReadBytes` |
| `maxCommitAttempts` | 3 | 1..8 |
| `maxInvocations` (unit steps plus busy sleeps) | 512 | 1..512 |
| `maxRetries` (platform retries of one unit step) | 3 | 0..10 |
| `retryDelayMs` (exponential backoff base) | 1000 | 10..300000 |
| `pollIntervalMs` (margin after a reported lease expiry) | 1000 | 10..300000 |
| `stepTimeoutMs` (one unit step attempt) | 600000 | 1000..1800000, and at least `(unitsPerInvocation + 2) * leaseMs + 1000` |

The canonical spec is limited to 64 KiB. The instance ID must equal
`spec.workflowId`. Busy sleeps share the `maxInvocations` budget, so an instance
has at most `maxInvocations + 2` steps (514 with the maximum): validation, unit
steps and sleeps, publication. The step timeout bound covers a claim or restore
and every unit of one invocation, each within one lease, plus one more lease
and a 1 s guard (see the deadline below).

## Durable steps

1. `validate-checkpoint-workflow` has no retries. It verifies the hashes and
   resolves the registry entry by name. The entry's `implementationVersion` must
   equal the identity's. The step then binds the entry and preflights the
   complete runner configuration (`preflightCheckpointedMediaUnit`), so a bad
   destination, limit or adapter fails before any journal call.
2. `unit-<n>` runs one invocation with `maxUnits = unitsPerInvocation`. Each step
   result is a compact record (outcome, revision, lease or wake time, journal
   digest, destination size and SHA-256) and never the journal itself.

   | Runner outcome | Workflow action |
   | --- | --- |
   | `yielded` | The next step continues with the same lease (`resumeLease`), so the instance does not wait for that lease to expire. |
   | `aborted` (only the step's own deadline) | Persisted as `yielded`: the invocation stopped at a committed boundary or before finishing finalization. |
   | `busy` | `step.sleep('busy-<n>', sleepMs)` until `wakeAt = max(expiresAt, now) + pollIntervalMs`, using the lease expiry reported by `status()`. The step result persists both `wakeAt` and the duration `sleepMs = wakeAt - now`, so a replay passes the same name and duration (the local engine keys sleeps by both, and its `sleepUntil` rejects a timestamp that has already passed). |
   | `finished` | Go to step 3. |
   | `cancelled`, `lease-lost`, `output-conflict` | The instance ends with `MediaCheckpointWorkflowError`, thrown outside any step. |
   | thrown `TypeError`/`RangeError` | Recorded as a `failed` outcome, which ends the instance the same way. This covers configuration and limit errors, component contract violations from the runner and an identity conflict on the journal. |
   | any other thrown error | Rethrown for the step's bounded platform retries (`maxRetries`, exponential `retryDelayMs`). |

   The runner restarts from the committed journal head in every attempt.
   Exhausted retries fail the step and the instance. `maxInvocations` bounds the
   schedule (`exhausted`).

   **One live holder per lease.** The coordinator compares only a lease's
   generation and token, so two executions holding one lease would both
   heartbeat and commit. A platform step timeout does not stop its callback
   either: the local engine races the callback against a timer and starts the
   retry while the abandoned callback still runs. The driver therefore:

   - aborts every attempt at its own deadline, `stepTimeoutMs - leaseMs - 1000`.
     The runner stops at the next unit boundary (the unit in flight still has to
     fit its lease), inside `process` through the signal, or during
     finalization. The stopped attempt settles before the platform timeout and
     is persisted as `yielded` with its lease. With the bound above, a run whose
     units fit their leases never reaches the deadline, so it is a backstop for
     overrunning units and slow finalization.
   - hands a lease only to an execution that no other execution can still be
     using. The lease the previous step yielded (that step's callback returned)
     goes only to this step's first attempt (`ctx.attempt === 1`, and the first
     attempt this run started). A retry resumes the newest lease of an earlier
     attempt of the same step that already settled (returned or threw) in this
     run, and only while no other attempt of the step is still running here.
     Every other attempt claims. While an abandoned holder still renews its
     lease, the claim reports `busy` and the instance sleeps until that lease
     expires.

   A step engine that passes no context gets no handoff, and every yield is then
   followed by a `busy` wait. After an isolate or runtime restart, a re-run
   attempt has no settled predecessor in memory, so it also claims and may first
   wait out its own abandoned lease. Retries after a failed attempt in the same
   isolate reuse that attempt's lease, so a persistent error uses up the retry
   budget instead of turning into `busy` waits.
3. `publish-checkpoint-workflow-result` re-reads the journal. The journal must
   still be finished, at the same revision and with the same digest of its
   committed descriptors. The step then publishes
   `checkpoint-workflows/<workflowId>/<specHash>.json` with a conditional write.
   The body holds the spec identity, the destination path, its byte length and
   SHA-256, the revisions, the output chunk count, and the journal head and
   digest. The destination SHA-256 is computed while the unit step's
   finalization streams the bytes it publishes, or the bytes of an existing
   destination it verifies, so it is a function of the finished journal and
   the patches, not of which path ran. A retry or lost acknowledgement
   verifies the stored size, metadata and exact bytes. The instance output is
   the manifest pointer (key, ETag, version, size, manifest SHA-256, path,
   bytes, `outputSha256`, revisions, journal digest).

The manifest pins the destination by content (size and SHA-256), not by storage
ETag or version, because the `VirtualFileSystem` does not expose them. The
digest records what finalization published or verified. A destination that is
later overwritten (an `overwrite: true` spec or another writer) no longer
matches it.

`publishMediaCheckpointWorkflowResult(bucket, spec, status, binding)` is the
direct form. Before it publishes, it verifies the destination itself
(`verifyMediaCheckpointWorkflowDestination`). That reruns finalization's
no-clobber verification through `binding.filesystem` and `patches`, with
writing disabled, so it never opens a writer. A missing destination, or one
whose content differs from the finished journal, publishes nothing. Pass the
coordinator's finished `status()`.

`lease-lost` means another owner claimed or advanced the journal, or a unit
outran `leaseMs`. Choose a lease that covers one unit with margin. A heartbeat
refused because another instance finished the same journal is not lost: the
runner verifies the destination and this instance publishes its manifest too. A
resume lease that expired between steps is not lost either: the runner claims a
new generation.

## Cancellation

```ts
const result = await cancelMediaCheckpointWorkflow(originalSpec, {
  workflow: env.CHECKPOINT_WORKFLOW, CHECKPOINTS: env.CHECKPOINTS,
});
// {workflowId, specHash, revision, journalPhase: 'cancelled', workflowStatus: 'terminated' | 'complete' | 'errored'}
// or {..., journalPhase: 'finished', workflowStatus: <current status>} (not terminated)
```

The helper verifies the spec. It then fences the journal: `initialize` (which
creates an absent journal, so an unstarted or late instance observes the fence)
followed by the coordinator's `cancel()`. Only then does it terminate the
platform instance. After the fence, an in-flight unit can no longer heartbeat or
commit. An already complete, errored or terminated instance is reconciled
by its platform status. A journal that already finished stays finished, and
the instance is not terminated, because termination could only cut off
finalization or manifest publication. The result then reports `journalPhase:
'finished'` and the instance's current status. Nothing is rolled back.
`MediaCheckpointWorkflowCancellationError.details`
reports whether the fence was confirmed, the journal phase and revision, the
termination state and the failures. A failed fence never terminates the
instance, and retrying the call is idempotent. Platform `terminate()` alone does
not fence the journal. The fence applies to the identity, so it also stops other
instances driving the same journal. Supply the original trusted spec and trusted
bindings: this API is not an authorization layer.

## Workerd acceptance

[`media-checkpoint-workflow.test.ts`](../../tests/workers/media-checkpoint-workflow.test.ts)
runs real local Workflows, the SQLite `MediaCheckpointCoordinator` and R2 in
workerd. The component is the audio FIFO (`createAudioReframeState`,
`asetnsamples=n=3`) over a pinned 23-sample stereo s16le 8 kHz R2 object, read in
5-sample ranged units. Like the [runner fixture](media-checkpoint-runner.md#workerd-acceptance),
the state blob carries each unit's emitted frame metadata.

- **Restart and retry.** With one unit per step and a 300 ms delay per unit, the
  whole runtime is disposed after at least two revisions committed and before
  the fifth. One transient R2 failure is injected at input position 10 and
  retried inside its step. The local engine schedules no wake-up after a process
  restart (the instance stays `running`), so the test reactivates it with
  `pause()`/`resume()`. Completed steps then replay from the engine's cache, and
  the interrupted step re-runs from the committed journal head. The test
  asserts that the journal ends at five revisions. The revisions committed
  before the restart are unchanged and all belong to the first lease
  (generation 1). Lease generations never decrease across revisions, with one
  owner per generation. In the recorded runs the restart came at revision 2:
  the re-run step reported `busy` behind the destroyed runtime's lease, and
  generation 2 committed revisions 3 to 5. That sequence was observed, not
  asserted. The R2 object is byte-identical to pinned Native FFmpeg
  (`aformat=s16p,asetnsamples=n=3:p=0,asetpts=PTS+123`, `pcm_s16le`, 92
  bytes). The manifest's `outputSha256` is the SHA-256 of the Native bytes, and
  the committed frame sizes and PTS equal Native `framecrc`. No staging is
  left.
- **Replay idempotency.** Republishing (the direct form, which re-verifies the
  destination) returns the identical manifest pointer. A second instance for
  the same identity verifies the existing destination (`existing: true`) and
  writes its own manifest without changing the destination version. After
  another full restart, the instance output and both object versions are
  unchanged. Cancelling the finished identity then reports `finished`, and the
  `complete` instance and the journal stay as they are.
- **Busy.** Another owner holds a 1.5 s lease before the instance starts. The
  first step is `busy` with a wake time at or after the reported expiry plus the
  margin. The instance then claims, finishes with one owner in all five
  revisions, and matches Native with `p=1` (96 bytes) and `framecrc`.
- **Cancellation.** A running instance is cancelled after its first commit. The
  journal is fenced, the instance is terminated, and no revision is added
  afterwards. No destination or manifest exists. Repeating the cancel succeeds,
  and a late instance for the same identity ends with `cancelled`.
- **Output conflict.** A different 92-byte object already at the destination ends
  the instance with `output-conflict`. The object and its version are
  untouched. Direct publication for the same spec is refused as a conflict, and
  no manifest or staging exists.
- **Implementation version.** A spec whose implementation version the registry
  lacks fails validation before any unit.

[Unit tests](../../tests/unit/media-checkpoint-workflow.test.ts) use a fake
durable step engine (cached step results, bounded retries with a 1-based attempt
context, recorded sleeps, and optional local-engine-style timeouts that leave
the abandoned callback running), the pure `state.ts` transitions, fake R2/VFS
and a Node stand-in for `crypto.DigestStream`. They cover:

- spec pinning, freezing, key-order-insensitive hashing, identity versus policy
  hashing and tampering
- malformed requests, including the step timeout bound, rejected before any
  `head`
- the yielded chain under one lease, and replay without journal calls
- busy wake times
- transient retry with lease continuation, and exhausted retries
- deterministic `failed`/`cancelled`/`lease-lost`/`output-conflict` ends,
  including an identity conflict failing without retries
- registry and preflight rejection before any journal call, and the invocation
  bound with busy sleeps counted against it
- a timed-out attempt still running inside its unit: the retry claims, reports
  `busy` and waits, the next owner finishes, and the abandoned attempt commits
  nothing once released
- an engine without attempt context getting no handoff
- the step deadline stopping an attempt mid-unit and continuing as `yielded`
  without waiting
- the destination SHA-256 in the manifest
- direct publication refusing a different or missing destination
- manifest lost-acknowledgement and conflict handling
- cancellation ordering, tombstones and reconciliation, with a finished journal
  never terminated

The [runner tests](media-checkpoint-runner.md#workerd-acceptance) cover the
preflight, verified finalization, `resumeLease` and heartbeat refusal after
another owner finished.

## Not implemented

- Automatic resumption of an in-flight instance after a local process restart.
  The test uses `pause()`/`resume()`. Production Workflows scheduling, attempt
  numbering (`ctx.attempt` as the local engine reports it: 1-based and
  persisted before each callback) and limits were not exercised. No deployment
  was tested.
- Queue delivery, parallel WorkUnits, graph partitioning, and joining several
  checkpointed units into one output.
- Error classification is by type. `TypeError` and `RangeError` are
  deterministic: configuration, limits, component contract violations from the
  runner and identity conflicts. Everything else is retried. Deterministic
  plain `Error`s fail only after the retry budget, for example a committed
  object digest mismatch (tampering) or an immutable object conflict.
- A resumed lease re-prepares a revision that an earlier attempt prepared but
  did not commit, under the same object prefix. The component must therefore
  produce byte-identical state and output for the same committed state and
  position. A non-deterministic component hits immutable object conflicts and
  uses up its retries.
- Lease renewal during a unit, release on yield (the coordinator has none),
  automatic garbage collection of orphaned attempt objects (the Workflow does not
  call the explicit [orphan collector](media-checkpoint-collection.md)) and of
  manifests, and journals longer than 256 revisions.
- Pinning the destination by storage ETag or version: the manifest pins its
  content only.
- Container-aware assembly beyond the runner's byte concatenation and
  fixed-length patches, and multiple outputs.

Byte limits bound individual objects, not total heap or CPU. The workerd
acceptance on this page covers the audio FIFO component only; the
[checkpointed audio pipeline](checkpointed-audio-pipeline.md#verified-evidence)
runs through the same unchanged driver in local workerd. It does not establish
production deployment readiness or full FFmpeg compatibility.
