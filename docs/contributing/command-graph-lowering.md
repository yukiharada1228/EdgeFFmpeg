# Operator graph command lowering

`lowerIndependentCommand(unit, bindings, {globalArgs})` from `@edge-ffmpeg/core`
converts a supported linear operator component into FFmpeg CLI arguments and
explicit file declarations. It walks the graph itself; the caller supplies typed
operator configuration instead of a command-building callback.

Bindings are keyed by exact node ID:

| Operator kind | Binding kind | Configuration |
| --- | --- | --- |
| source | source | absolute VFS `path`, relative R2 `key`, optional input `options` |
| demux, decode | input-options | input `options` |
| filter | filter | `mediaType` audio/video and `expression` |
| encode, mux | output-options | output `options` |
| sink | sink | absolute VFS `path`, optional output `options` |

One component must be a single path with one source and one sink. Supported stage
order is source, optional demux, optional decode, filters, optional encode,
optional mux, sink. Repeated non-filter stages, branches, joins and cycles are
rejected rather than flattened. Every graph node requires exactly one matching
binding. Filter media types must agree with the graph's frame ports.

The lowerer retains input/output option scope and filter order. It rejects
option fragments that introduce another file, escape into global scope or
replace the graph's filters/maps. Global complex filter graphs are unsupported.
Generated CLI is parsed again to verify exact declared input and output paths.
The returned arguments and declarations are immutable. This validates lowering
structure; backend execution still validates codec/filter options and actual
media compatibility. Registry feature names are not inferred from arbitrary
expression text or codec option values.

## Persistent execution

`buildCommandGraphMediaWorkflowSpec` from
`@edge-ffmpeg/runtime-cloudflare/jobs` combines independent graph partitioning,
this lowerer, exact external input pinning and the persistent Workflow engine:

```ts
const {spec} = await buildCommandGraphMediaWorkflowSpec({
  graph, registry, bindings,
  bucket: env.MEDIA_BUCKET,
  workflowId: 'audio-graph-001',
  budget,
  implementationVersion: 'backend-v1',
  globalArgs: ['-cpuflags', '0'],
  maxParallel: 2,
});
await env.MEDIA_WORKFLOW.create({id: spec.workflowId, params: spec});
```

Each disconnected component becomes one command job. Exact source graph
provenance is included in Workflow identity; lowered options also participate in
command identity. Missing/extra bindings and unsupported lowering fail before
R2 metadata reads. The adapter snapshots bindings before asynchronous hashing
or input pinning. It does not require `commandForWorkUnit`; that older callback
adapter remains available for custom whole-command lowering.

Actual local Workflows/Queue/SQLite/R2 acceptance lowers two six-stage paths
(source/decode/filter/encode/mux/sink), verifies their generated arguments against
the existing explicit CLI and compares committed WAV bytes with independent
execution. Two additional differential cases execute the lowered commands against
the pinned Native FFmpeg binary and verify exact raw PCM for one volume filter
and two ordered volume filters, including odd and extreme s16 samples. This is
scoped lowering evidence and does not promote broad Native capability status. [Complex video lowering](complex-command-graph-lowering.md) now supports explicit
video split/branch/join topology as a complete command. Connected-stream splitting,
audio complex graphs, serialized component continuation and generic lowering
for every FFmpeg graph remain open.
