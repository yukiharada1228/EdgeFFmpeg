# Independent graph planning

`planIndependentGraph(graph, registry, runtime, workerBudget)` from
`@edge-ffmpeg/core` discovers weakly connected components of an operator graph.
Each complete component becomes one independent WorkUnit. Components are ordered
by their canonical node membership; IDs use injective JSON membership rather
than a delimiter that could collide with node IDs. These IDs are metadata, not
Cloudflare job IDs. Inputs, output metadata and descriptor snapshots remain
immutable in the resulting plan.

Each component passes the existing graph validation, runtime capability
resolution and per-Worker lower-bound memory/packet-slot admission checks.
Disconnected components may collectively exceed one Worker's budget because
they execute in separate jobs. Aggregate memory, packet slots and CPU estimates
are reported separately; unsafe integer sums are rejected. Unknown CPU estimates
propagate as unknown. Known estimates above the Worker budget produce warnings:
estimates do not prove actual execution cost or make an indivisible component
splittable. Runtime resource enforcement remains required.

State, input access, checkpoint availability, temporal dependencies and
determinism are aggregated conservatively. Shared-source fanout, joins and all
connected stateful or temporal paths remain in one component. Even a
`checkpointable: true` declaration does not authorize arbitrary stream cuts or
establish a serialized codec implementation. Descriptor compatibility statuses
are preserved without promotion. The planner executes no media itself.

## Cloudflare execution

`buildIndependentMediaWorkflowSpec` connects these partitions to the persistent
[Workflow command engine](media-workflows.md):

```ts
const {spec, plan, workUnits} = await buildIndependentMediaWorkflowSpec({
  graph, registry, budget, bucket: env.MEDIA_BUCKET,
  workflowId: 'conversion-001', maxParallel: 2,
  commandForWorkUnit(unit) {
    // Application-specific lowering of this complete component.
    return commandsByComponent.get(unit.id)!;
  },
});
await env.MEDIA_WORKFLOW.create({id: spec.workflowId, params: spec});
```

The application supplies a complete FFmpeg command for each component: arguments,
external object inputs, output paths and implementation version. Supported linear components now also have a
[typed graph-to-CLI lowerer](command-graph-lowering.md), which removes this callback
for that scope. [Complex video lowering](complex-command-graph-lowering.md) also
handles explicit video branches/joins within one command. Generic operator
graph-to-CLI compilation remains open. The adapter enforces the same resource
budget for each command and rejects artifact dependencies between these
independent components. It validates Cloudflare runtime support, rejects more
than16 components before lowering/pinning and maps canonical components to
`unit-0`, `unit-1`, etc. Shared external keys are pinned once across the workflow.

A canonical `sourceGraphHash` covers component membership, operator descriptors,
ports, resource traits and admission budget. It participates in the Workflow's
immutable graph hash, so an identical command list derived from a different
source graph has a different identity. Commands, scheduling and provider methods
are captured before asynchronous graph hashing or R2 pinning. Existing explicit
Workflow specifications without this optional provenance retain their identity.

Actual local Workflows/Queue/SQLite/R2 acceptance converts a graph with two
independent source-to-sink components into two command jobs and compares their
WAV output bytes against independent execution. This demonstrates automatic
component discovery and its execution adapter, not generic graph lowering,
Native codec certification, simultaneous CPU execution or temporal partitioning.
