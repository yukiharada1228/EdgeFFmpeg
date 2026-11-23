# Durable media jobs

`@edge-ffmpeg/runtime-cloudflare/jobs` adds persistent whole-command execution.
One SQLite Durable Object coordinates one job; a repeating alarm dispatches a
Queue message until a worker claims it. The existing `FFmpeg` backend executes
the complete command. Retries start again from the pinned input generations.

This implements the first persistent WorkUnit and finalization path from design
section 11. It does not serialize codec/filter/Wasm state or split a media stream.
Explicit whole-command DAG orchestration is available through
[media Workflows](media-workflows.md). Automatic graph partitioning, media merge
orchestration and component checkpoints remain open. `graphHash` currently hashes the single-command WorkUnit
descriptor, arguments, media budget and implementation version, not an expanded
codec/filter graph. `inputFingerprint` hashes the pinned object identities.

## API and deployment bindings

The actual runnable local fixture is
[`durable-media-job-fixture.ts`](../../tests/workers/durable-media-job-fixture.ts).
Its [configuration](../../tests/workers/durable-media-job.wrangler.jsonc) declares
`JOBS` (SQLite DO), `MEDIA_JOB_QUEUE` and `MEDIA_BUCKET`, with generated binding
types. It is a conformance fixture, not a deployed public service.

```ts
import { buildMediaJobSpec, consumeMediaJobs } from '@edge-ffmpeg/runtime-cloudflare/jobs';
export { MediaJobCoordinator } from '@edge-ffmpeg/runtime-cloudflare/jobs/durable-object';

// In a trusted application, after authorizing access to the source object:
const spec = await buildMediaJobSpec({
  bucket: env.MEDIA_BUCKET,
  jobId: 'conversion_1',
  args: ['-f', 's16le', '-ar', '8000', '-ac', '2', '-i', '/input.raw',
         '-c:a', 'pcm_s16le', '/output.wav'],
  inputs: [{ path: '/input.raw', key: 'source/input.raw' }],
  outputs: [{ path: '/output.wav' }],
  budget: { maxResidentBytes: 33554432, maxBufferBytes: 65536,
            maxCpuTimeMs: 15000, maxPendingPackets: 8 },
  implementationVersion: 'application-backend-and-codec-pins-v1',
  maxAttempts: 3,
  leaseMs: 30000
});
await env.JOBS.getByName(spec.jobId).submit(spec);

// In the queue handler (backend is the application's configured backend factory):
await consumeMediaJobs(batch, {
  bucket: env.MEDIA_BUCKET,
  backend,
  implementationVersion: 'application-backend-and-codec-pins-v1',
  coordinatorFor: id => env.JOBS.getByName(id)
});
```

The Workers-only Durable Object entry point is a separate export so importing
job specifications/execution helpers in Node does not import a Workers builtin.
A narrow type-only alias uses the official Workers module declarations without
installing their globals into unrelated Node tests. Portable media packages
still cannot import platform APIs.

## Persistence and publication

Submit snapshots and validates a bounded immutable specification. Reusing an ID
with different arguments, object pins, budget or implementation version fails.
Submit also checks that the Durable Object ID matches the declared job ID.
Each input is pinned by R2 key, ETag, version and size, including same-content
replacements. All pins are checked before execution and before success; every
ranged read verifies the original generation. Applications must change the
implementation version when backend code, codec artifacts or arithmetic profiles
change. This is an application pin, not automatic attestation of backend code.

State and alarm changes share a SQLite transaction. Queue sending occurs after
that transaction; repeating alarms recover failed sends, lost deliveries and
expired leases. A generation/token/expiry lease fences heartbeat, failure and
success. Cancellation is persisted and prevents subsequent authoritative success.
The queue consumer acknowledges terminal jobs, retries active duplicates and
processes one message at a time within a batch. Independent queue invocations can
execute different jobs concurrently.

Outputs are immutable objects under `jobs/<jobId>/<generation>/<token>/`.
CLI overwrite flags never replace a shared R2 output. The authoritative publication
is the succeeded job record's artifact list, stored atomically with job state.
Clients should resolve output through that record. A stale attempt may leave
private objects but cannot change the winner's pointer. Retrying finalization is
idempotent only for the same lease and the exact same artifact metadata. The
coordinator binding and R2 write capability are trusted application interfaces;
the fixture's control endpoints are for tests, not an authorization layer.

A lost success response preserves private objects and resolves the persisted
result on retry. Uncertain or abandoned attempt objects are retained; automated
artifact garbage collection is not implemented. R2 is not cross-system atomic
with SQLite: immutable objects plus the single authoritative pointer avoid a
shared-key overwrite race.

## Resource limits and evidence

The executor reserves a conservative envelope for R2 multipart buffers and read/
write payloads before assigning the remaining resident budget to FFmpeg. Read and
write chunks are bounded to 64 KiB or the job's smaller buffer limit. Insufficient
budgets fail before invoking the backend. A conservative wall-time deadline uses
the existing execution time budget; this does not measure platform CPU time or
certify process peak memory. Failed attempts and metadata are bounded, and
maxAttempts limits whole-command replay.

The local Workers integration exercises actual SQLite, R2 and Queue bindings
without Node compatibility. It covers concurrent duplicate requests, real Queue
delivery, full runtime restarts, running/completed state retention, lease expiry,
stale completion, cancellation during backend execution, lost success replies,
input/implementation pin changes and retry exhaustion. Its PCM/volume/WAV bytes
are compared to independent single-Worker execution. This establishes orchestration
parity for that case, not new Native codec conformance or remote deployment proof.
The installed workerd supports compatibility date `2026-11-18`; the fixture pins
that supported date. Official API docs and the latest published Workers type
reference were inspected; no SDK upgrade or deployment was performed.

References: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Queue acknowledgements and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/),
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

The separate [audio FIFO checkpoint API](reframe-checkpoints.md) now serializes
one verified filter component. Whole-command job retries still replay input and
do not automatically restore that component within a complete media pipeline.
