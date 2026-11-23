# Bounded multiple-output video graphs

The FFmpeg-compatible rawvideo CLI backend accepts one `-filter_complex` (or `-lavfi`) description,
one finite rawvideo input, and explicitly named output maps. Supported nodes are
`null`, `format`, constant-size `scale`, `hflip`, `vflip`, `transpose`, `split`
`nullsink`, `hstack` and `vstack`. Split has 1..32 outputs. Stack nodes
join 2..32 synchronized branches from the same source; other nodes have one input.
Graphs have at most 4096 UTF-16 code units, 32 nodes and 128 aggregate pads.
Every external output must be mapped once. Output paths must be distinct.

```sh
npm run ffmpeg -- --root ./media -- -f rawvideo -pixel_format gray -s 3x2 -i /input.raw \
  -filter_complex '[0:v]split[a][b];[a]hflip[left];[b]vflip[right]' \
  -map '[left]' -f rawvideo /left.raw \
  -map '[right]' -f framecrc /right.crc
```

Each output has its own pixel format, constant size, seek/duration and frame
limit. Joint negotiation registers sinks in external-pad order; map order
controls file publication order. Rawvideo uses scoped fixed-rate CFR timing,
including the pinned Native startup repetition. Framecrc uses VFR timing.
The fourteen layouts and arithmetic restrictions in [pixel-resize.md](pixel-resize.md)
apply, including the guarded unstable Native ARM NV12/NV21 conversion cases.

## Frame API

```ts
import {compileVideoFilterGraph} from '@edge-ffmpeg/avfilter';
const graph = compileVideoFilterGraph('split[left][right]');
const plan = graph.plan({format: 'gray', width: 3, height: 2}, ['gray', 'rgb24']);
const outputs = plan.apply(frame, {
  maxFrameBytes: 1024, maxStateBytes: 4096, maxResidentBytes: 16384,
});
```

`outputs` follows external-pad order. Each returned frame owns tight output
planes. Timestamps and time bases are preserved; metadata is shallow-copied.
`plan.process(source, budget)` yields one output batch per source frame and
closes the upstream iterator on cancellation or early consumer termination.
Planning exposes maximum frame bytes, state bytes, allocated frame bytes and
required typed payload bytes. These budgets cover typed frame/scratch payloads;
JavaScript object overhead and caller-retained batches require additional memory.
CPU time enforcement, pooling and whole-runtime memory certification remain pending.

The structural `parseFilterTopology` API accepts registry-supplied pad counts and
media types, preserves cyclic links, and returns frozen endpoints. The separate
`filterTopologyOrder` rejects cycles for DAG execution. Registry-only structural cases for audio or overlay do not imply execution
support for those filters.

## Output publication and recovery

The CLI reserves bounded output queue slots before reading another source frame.
All writers prepare before publication starts. Commits then occur in file order;
publication across files is recoverable and can partially succeed. It is not a
single atomic transaction. Failures retain confirmed published paths in
`ExecResult.outputs`, with per-output effects in the error. A rejected publication
with no positive acknowledgment remains `uncertain` and retains recoverable staging.
R2 recovery only deletes staging after positive publication verification.
Durable job recovery orchestration is still pending.

## Verification and limits

Regression tests cover 210 pinned Native structural cases, 6,576 complete
frame-API outputs, 6,144 complex CLI outputs, 1,728 fixed-rate timing cases and
512 outputs through the Node launcher. Local workerd tests compare 32 outputs
against ARM/x86 Native anchors and exercise publication acknowledgment loss,
pre-publication failure and staging cleanup failure. Recorded fixtures carry
reference build and oracle provenance; they do not establish full conformance.

Multiple physical inputs, overlay, feedback execution, repeated use of a source
through multiple external input pads, automatic unnamed output mapping, arbitrary
expressions, compressed codecs and deployed Cloudflare verification remain
unimplemented. Native binaries and C oracle shims are development-only tools.

To regenerate the structural fixture, run `npm run reference:filter-topology`
with the pinned host reference libraries available. `npm run reference:complex-workers`
regenerates both arithmetic-profile anchors using the pinned Darwin ARM reference
and Linux x86 reference inside the locked, network-disabled Docker image. These
commands verify reference commits, flags and binary hashes before generation.

The implementation status for `split`, `nullsink`, `hstack` and `vstack` remains `partial`.
The project still targets full pinned-reference compatibility; passing these
scoped cases does not upgrade a feature to `conformant` or `bit-exact`.

## Synchronized branch joins

For example, `[0:v]split[a][b];[a]hflip[x];[x][b]hstack[out]` joins a
flipped branch and an original branch horizontally. `vstack` joins vertically.
`inputs` accepts decimal counts 2..32; `shortest` accepts the declared boolean
values, and has identical timing for branches from this one fixed-rate source.
General expression evaluation and framesync between independent sources remain
unimplemented in the execution graph.

Horizontal inputs must share height; vertical inputs must share width. Negotiation
selects a common pixel format across every stack input and output. Plane placement
follows the pinned Native ceil chroma offsets. If several odd subsampled branches
would cause overlapping concurrent chroma writes, planning rejects the graph before
file I/O. A final chroma overhang outside visible output is clipped.

`stackVideoFrames(frames, direction, {maxFrameBytes, signal})` exposes the owned
frame operation directly, with matching pixel formats and synchronized timestamps.
Stack output metadata starts empty, matching Native frame construction. Positive
padded strides are accepted within the per-frame storage limit. The graph planner
accounts for every incoming conversion and the joined output payload.

Stack regression evidence includes 1,344 API outputs, 6,144 complex CLI outputs,
512 Node outputs and 32 ARM/x86-anchored R2 outputs. A development-only Native
probe additionally checks 4,032 input-pad and sink negotiation geometries. These
remain scoped comparisons; `hstack` and `vstack` are recorded as `partial`.

`npm run reference:stack-workers` regenerates the synchronized stack ARM/x86
Native anchors and their Workers case recipes with the same locked reference
provenance checks used by the complex-output fixtures.

The [multiple-input frame APIs](multi-input-video.md) support synchronized batches
and finite replayable streams outside the current single-input CLI path.
