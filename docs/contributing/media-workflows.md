# Persistent media Workflows

`@edge-ffmpeg/runtime-cloudflare/jobs` exports `buildMediaWorkflowSpec` for an
explicit DAG of complete FFmpeg commands. Export `MediaWorkflow` from
`@edge-ffmpeg/runtime-cloudflare/jobs/workflow` in a Workers entrypoint, alongside
the existing `MediaJobCoordinator` and Queue consumer. The runnable binding and
creation example is [the local fixture](../../tests/workers/media-workflow-fixture.ts)
and [its Wrangler configuration](../../tests/workers/media-workflow.wrangler.jsonc).
Create the platform Workflow instance with `id: spec.workflowId, params: spec`.

Each node declares command arguments, input/output VFS paths, implementation
version and resource budget. External inputs use `{kind:'object', key}`; the
builder pins each distinct key once. A dependent input uses
`{kind:'artifact', nodeId, path}` and receives the producer's exact committed
key, ETag, version and size. It never repins a mutable output key. All descriptors
are snapshotted before asynchronous provider calls and hashed into graph identity.
Cycles, missing producers and undeclared output references are rejected.

Ready nodes are submitted up to `maxParallel`; actual execution uses Queues.
Durable steps derive specifications, submit jobs, poll terminal states and publish
the result. Step retries are bounded (three retries for provider operations;
validation has no retries). Failed commands or exhausted polling cancel unfinished
children. Cancellation atomically submits and cancels the expected specification:
an absent job becomes a cancelled tombstone, so a delayed submit cannot start it.
A conflicting pre-existing specification is preserved.

After every node succeeds, a conditional R2 write publishes an immutable JSON
manifest at `workflows/<workflowId>/<graphHash>.json`. It contains artifact
pointers rather than media bytes. Replays and lost write acknowledgements verify
the exact stored body and metadata. There is no cross-service R2/Workflow global
transaction; private attempt objects can remain after failure.

The library bounds requests to 16 nodes, 256 KiB of canonical specification,
16 active jobs, 256 polling rounds and 512 KiB of manifest data. These are upper
bounds, not guaranteed concurrency or completion time. Choose polling policy for
the deployment's [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/):
the maximum graph/poll combination can exceed the Free plan's step allowance.
Defaults are two active jobs, one-second polling, three command attempts and
30-second renewable job leases.

Actual local workerd acceptance executes two independent roots and a third node
consuming one root's WAV artifact. It checks byte equality with independent
execution, exact parent generations, bounded readiness, failure cancellation,
late submissions, conflicting identities and completed-result persistence across
a full runtime restart. Local Queue scheduling does not certify simultaneous
CPU execution. Automatic resumption of an in-flight Workflow across a local
runtime restart remains unverified. Direct platform termination does not run
the failure handler and does not automatically cancel children. Use the explicit
cancellation API below to fence child execution as well.

This API orchestrates complete commands. [Independent graph planning](independent-graph-planning.md)
can now discover disconnected components and lower them through an application
callback. Splitting connected media paths, generic graph-to-command compilation,
cross-Worker stream joins, serialized codec/filter/Wasm continuation and orphan artifact
collection remain open. No production deployment or new Native FFmpeg
compatibility certification is implied by these orchestration tests.


## Cancel a complete workflow

```ts
import {cancelMediaWorkflow} from '@edge-ffmpeg/runtime-cloudflare/jobs';

const result = await cancelMediaWorkflow(originalSubmittedSpec, {
  workflow: env.MEDIA_WORKFLOW,
  JOBS: env.JOBS,
});
```

Retain the original submitted specification in the application. The API validates
its graph hash, then persists a cancellation fence in every node's SQLite DO,
including dependent nodes whose input artifacts do not exist yet. New derived
jobs bind their immutable specification to `{workflowId, graphHash, nodeId}`.
A late matching submission is recorded as cancelled and cannot be claimed.
Existing running jobs lose their lease; existing successful jobs and already
committed results remain successful. Cancellation does not roll back output.

After all node fences are confirmed, the helper terminates the platform instance.
An already complete, errored or terminated instance is reconciled by its actual
platform status. `MediaWorkflowCancellationError.details` identifies confirmed
node fences, failed node IDs and whether termination was confirmed. Any node
failure leaves orchestration termination unattempted: successful fences remain
persisted, and retrying the same API safely completes partial cleanup. This
avoids terminating an instance after an ownership conflict. Provider failures
must be retried by the application; the helper does not hide partial success.

Supply the original trusted specification and trusted service bindings; this API
is not an authorization layer. Fences and cancellation are atomic per job, not
across all jobs and the platform instance. Never reuse workflow IDs for another
graph. Legacy workflow jobs without the ownership field remain readable and
executable, but cannot acquire this new cancellation scope retroactively: drain
those runs using their original job cancellation path before migration. Existing
standalone job specifications remain valid.
