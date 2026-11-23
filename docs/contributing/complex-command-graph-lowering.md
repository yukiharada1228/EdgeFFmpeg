# Typed complex video graph lowering

`lowerComplexVideoCommand` from `@edge-ffmpeg/core` lowers an explicit video
filter DAG into a complete command with generated `-filter_complex` labels and
output `-map` options. Bindings use the same typed source, input-options, filter,
output-options and sink declarations as [linear lowering](command-graph-lowering.md).

Every source prefix is a unary source → optional demux → optional decode path.
Every output suffix is a unary optional encode → optional mux → sink path.
Between them, explicit filter nodes may split, branch or join through named
video-frame ports. Each filter's declared input and output port order determines
its link order; sorting port names would change stack and split semantics.
Sources, sinks and generated link identities are ordered canonically by node IDs,
so graph declaration order does not change generated command identity.

The lowerer requires every node to be covered and every declared filter pad to
be connected, with at least one input and output per filter. Filter-only
sources/sinks such as testsrc/nullsink are outside this adapter. Shared non-filter
paths, implicit fanout and mixed/audio frame filters are rejected. Source paths, object keys and output paths are validated;
input/output collisions and duplicate file declarations fail. Complex labels and semicolon topology separators are unsupported in binding
expressions. Multi-pad nodes require a single filter expression and reject commas,
including quoted commas; unary nodes retain the existing filter-chain fragment
behavior. File option fragments cannot
introduce additional files, override the graph or escape their declared scope.
Final CLI parsing verifies the generated input/output list and filter/map scope.
The resulting command and declarations are immutable and bounded.

These label and ordered-pad rules follow the
[FFmpeg filtergraph syntax](https://ffmpeg.org/ffmpeg-filters.html#Filtergraph-syntax).
Graph-to-command lowering is structural: the media backend still resolves and
validates actual filter/codec options and format compatibility. Feature registry
metadata does not automatically make an operator executable.

## Persistent execution

```ts
const {spec} = await buildComplexVideoGraphMediaWorkflowSpec({
  graph, registry, bindings,
  bucket: env.MEDIA_BUCKET,
  workflowId: 'video-graph-001',
  budget,
  implementationVersion: 'backend-v1',
  globalArgs: ['-cpuflags', '0'],
  maxParallel: 2,
});
await env.MEDIA_WORKFLOW.create({id: spec.workflowId, params: spec});
```

The builder is exported from `@edge-ffmpeg/runtime-cloudflare/jobs`. Independent
components become separate command jobs; a connected branched/joined filter graph
stays in one command job. Source graph provenance, lowered command options and
input generations participate in persistent identity. No application argv
callback is required. Unsupported lowering fails before R2 input metadata reads.

This does not partition one connected filter graph across Workers, serialize
codec/filter/Wasm state or add arbitrary audio complex graph execution. Native
comparisons and actual Workflow acceptance are scoped to the tested video graphs;
they do not certify all filter expressions or general FFmpeg graph compatibility.


The scoped oracle cases use three finite gray 2×2 frames. One graph splits into
hflip/null branches and joins them in declared hstack pad order; a separate graph
writes both branches through independent encoder/mux/sink suffixes. Raw output
bytes match the pinned Native FFmpeg binary. Local Workflow acceptance executes
both graphs through Queue/SQLite/R2 and verifies exact bytes and artifact
ETag/version pins. These tests do not demonstrate two-source execution or
simultaneous CPU processing.
