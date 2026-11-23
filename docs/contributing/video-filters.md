# Linear video filters and format negotiation

`compileVideoFilterChain` compiles bounded single-input/single-output paths of `null`, `scale`,
`format`, `hflip`, `vflip` and `transpose`. Descriptions have at most 4096 characters and 32 explicit nodes.
An empty whole option string (`null=`, `scale=`, `format=`, `hflip=` or
`vflip=` or `transpose=`) uses the same defaults as the bare filter. Explicit empty
`format=pix_fmts=` selects YUV420P, while `format=` adds no constraint.
Execution is frame-local inside the asynchronous, backpressured rawvideo path.
Connected labels and multiple textual chains may describe one execution path.
The separate [multiple-output graph API and CLI](complex-video.md) supports
bounded split branches and synchronized `hstack`/`vstack` joins. Multiple media inputs, expressions and general filter
graphs remain incomplete and fail before file I/O.

Scale supports positive constant sizes (`scale=13:7`, `scale=w=13:h=7`,
`scale=width=13:height=7`), the pinned native size names and default
`flags=bicubic`. Bare `scale` preserves dimensions. Height-only `scale=h=7`
retains the current width; `size`/`s` accept declared size syntax. Width-only
fields use native size syntax. Positional default flags and repeated string
options follow the rules below. The fixed B=0/C=0.6 resizer
supports the fourteen declared gray/YUV/RGB layouts and their 196 directed pairs
within the [documented arithmetic scope](pixel-resize.md).

Format supports a declared format or a pipe-separated candidate list, such as
`format=nv12`, `format=pix_fmts=gray8|nv12` or `format=rgba|bgra`. Aliases are
normalized and duplicate canonical formats are rejected. Bare `format` adds no
constraint. Fixed-reference numeric IDs and the aliases described below are supported.
Color-space, range and alpha-mode options remain unimplemented. Every listed format must belong to the fourteen declared layouts.

## Linear graph quoting and options

Single quotes and backslashes are decoded separately at graph and option layers,
following `av_get_token`. Quoted or escaped commas remain inside an option;
`scale='13,7'` is one size operator. Values such as `format='rgba|gray'` retain
format-list semantics after lexical decoding. Protected whitespace survives its
current layer and is then processed by the next layer. Native end-of-string
behavior for unclosed single quotes is retained.

Named options disable later positional shorthand. For example, `scale=13:h=7`
is supported while `scale=w=13:7` fails. Repeated string options apply in order;
only final width, height, size, pixel-format and flag strings are validated.
A trailing comma or terminal semicolon is accepted for a single chain. Branches,
multiple media inputs, expressions, timeline options and other filter options remain
incomplete and fail before media I/O.

The parser retains the 4096-character and 32-operator limits. Counting occurs
after graph tokenization. Parsed steps, stages and candidate sets stay immutable;
resource preflight includes intermediate formats selected by decoded options.

## Fixed-reference format tokens

The format filter follows the pinned LP64 `strtol(base=0)` semantics: decimal,
leading-zero octal and `0x` hexadecimal forms, optional sign, signed64 saturation
and signed32 enum storage. Every remaining digit is validated even after
saturation. Work is bounded by the 4096-character graph limit. Other numeric IDs
remain outside the fourteen implemented layouts.

| ID | Format | ID | Format |
|---:|---|---:|---|
| 0 | yuv420p | 2 | rgb24 |
| 3 | bgr24 | 4 | yuv422p |
| 5 | yuv444p | 8 | gray |
| 23 | nv12 | 24 | nv21 |
| 25 | argb | 26 | rgba |
| 27 | abgr | 28 | bgra |
| 33 | yuva420p | 71 | gbrp |

These IDs belong to the fixed FFmpeg 9.0.2 target. The two recorded reference
builds are little-endian: `rgb32` resolves to BGRA and `bgr32` to RGBA. Gray aliases
`gray8` and `y8` are case-insensitive. Canonical names retain native case rules.
This parsing applies to the format filter; rawvideo input/output format options
retain their existing declared-name scope.

Empty candidate elements select ID 0. Thus `format=rgba|` allows RGBA or YUV420P,
and `format=pix_fmts=` requires YUV420P. Canonical duplicates are rejected after
name, alias and numeric normalization. Filter and option-key whitespace uses ASCII
space, tab, CR and LF; candidate-internal whitespace is preserved for validation.
Linear quoting/escaping follows the parsing layers below. Additional format
options and general graph topology remain incomplete.

## Reflection filters

Bare `hflip` and `vflip` support all fourteen declared layouts. They reflect each
plane using its own chroma dimensions; packed RGB pixels and interleaved UV pairs
retain their component order. Candidate formats propagate through these nodes,
so automatic conversion can occur before or after a reflection according to graph
negotiation. Explicit scales remain independent format boundaries.

The public `flipVideoFrame(frame, 'horizontal' | 'vertical', options)` helper and
graph execution materialize an owned tight buffer with positive strides. This
keeps downstream operators independent of native negative-stride views. Padded
positive input strides are supported; negative-stride input remains unsupported.
The entire declared plane storage counts toward `maxFrameBytes`. Graph plans
reserve every reflected intermediate frame and require no coefficient workspace
for reflection itself. Exact bigint PTS is copied and opaque metadata is shallow
copied; side-data transformations and general metadata semantics are incomplete.

Timeline `enable` expressions and reflection options remain unsupported and fail
before file I/O. These frame-local operators do not add checkpoints or distributed
state support.

## Planning and execution

```typescript
const graph = compileVideoFilterChain('scale=13:7,format=gray,scale');
const plan = graph.plan('rgba', 5, 3, {
  outputPixelFormat: 'nv12',
  outputSize: {width: 3, height: 2},
  arithmetic: 'scalar'
});
const output = plan.apply(frame, {
  maxFrameBytes: 65536,
  maxStateBytes: plan.stateBytes,
  signal
});
```

Format-preserving nodes share candidate sets. The planner intersects connected
sets, inserting an unchanged-size converter when sets are disjoint or their
intersection would discard chroma or alpha present in both sets. Singleton inputs
propagate before the remaining formats are selected using conversion-loss scores,
padded bits, component counts and the pinned format enumeration order. This
preserves conversion boundaries instead of choosing each list independently.

Scale nodes negotiate input and output independently. Output `-s` adds the final
scale after the explicit chain. A scale with unchanged dimensions remains a
binding position until negotiation is finished; removing it earlier can move
conversion across a quantized frame. Actual identity operations can then forward
the frame. At most one automatic converter per original link is permitted.

When output format is omitted, the graph negotiates its output from the remaining
candidates. Each plan exposes immutable `stages`, final dimensions/pixel format and a fixed
arithmetic profile. Application must use that negotiated profile and format; it
cannot override them after preflight. Default arithmetic is aarch64, independent
of execution-host ISA. Explicit scalar/x86_64 profiles and unchanged-size inverse
guards retain their [existing meanings](pixel-inverse.md).

The plan includes the largest frame, all intermediate pixel payload and the
conservative sum of coefficient/row workspaces. The CLI checks these before
opening files, including expanded intermediate formats followed by small output.
Application validates integer budgets, source geometry/format and cancellation.
Actual transforms return owned tight buffers, identity steps forward their input,
and exact bigint timestamps are retained. Opaque metadata is shallow-copied;
color/aspect metadata transformation remains incomplete.

Output `-vf`, `-filter`, `-filter:v`, `-filter:v:0` and `-filter:0` select the
single stream chain; the last matching option wins. Output size and pixel-format
options keep their output scope. Filtering and streamcopy are rejected together.
Scoped seek, duration, frame limits, short reads and staged output use the existing
rawvideo path. Native calls are confined to development tests.

## Reflection evidence

- 448 complete native raw helper outputs across fourteen layouts, eight source
  geometries (including one-pixel/odd/aligned cases) and four reflection sequences.
- 20,160 complete native graph raw outputs across every declared input/output
  pair, implicit output formats, three source geometries, eight mixed graphs,
  two appended-size conditions and default/scalar arithmetic with an independent
  payload seed. Exact bigint PTS is checked independently.
- 2,048 native CLI raw/framecrc outputs for explicit/implicit formats, timing,
  empty/zero streams, short reads and committed output.
- 256 native outputs through the actual staged Node launcher.
- Sixteen local workerd/R2 outputs match fresh default ARM/Linux framecrc anchors
  under explicit arithmetic profiles, with staging cleanup.
- Six unit tests cover padded storage, ownership, malformed planes/cancellation,
  intermediate reservations, arithmetic guards and unsupported options.

These scopes do not certify every pixel format, arbitrary side data, timeline
expressions, full Linux CI or production Workers performance.

## Existing scale and format evidence

- 14,112 complete native raw API comparisons: all 196 format pairs, three source
  geometries, eight chains, and three appended-size conditions, including identity
  scale anchors. Default arithmetic follows validated oracle metadata.
- 7,056 native raw API comparisons for single format constraints before, between
  and after scales.
- 1,152 whole native CLI raw/framecrc comparisons with four time/frame profiles,
  explicit intermediate constraints, appended sizes and eleven-byte reads.
- 896 whole native CLI outputs without explicit output pixel format, including
  empty input, zero frame limits/duration and clipped streams.
- 10,080 complete native candidate-list API outputs across all fourteen input
  formats, fourteen explicit and one implicit output, four list pairs, three
  graph placements, two size conditions and default/scalar arithmetic.
- 2,048 additional native CLI raw/framecrc comparisons for candidate lists,
  chroma/alpha-preserving boundaries, implicit output, timing, empty inputs and
  zero-frame selection.
- 128 complete native single-format outputs and 256 candidate-list outputs
  through the actual staged Node launcher.
- Sixteen single-format and sixteen candidate-list local workerd/R2 outputs
  under explicit aarch64/x86_64 profiles match
  freshly recorded ARM/Linux default framecrc anchors and check staging cleanup.
- Unit checks cover binding positions, immutable stages, arithmetic consistency,
  intermediate expansion, source/state/frame budgets and existing unscaled guards.

These scopes do not certify arbitrary metadata, general graphs, full
canonical Linux CI or production Workers performance. Resize
arithmetic retains its [recorded LGPL provenance](../../packages/swscale/NOTICE).
The format negotiation adaptation has its own [LGPL provenance](../../packages/avfilter/NOTICE).

## Numeric-format evidence

- Fixed header enumeration and 194 ARM/Linux numeric/boundary observations.
- 98 complete native spelling/boundary checks with implicit raw output.
- 12600 complete native API outputs across all declared input/output formats,
  fifteen distinct graphs and default/scalar arithmetic with an independent seed.
- 2048 complete native CLI outputs covering timed, empty and implicit output.
- 256 actual Node outputs and sixteen dual-profile local workerd/R2 anchors.
- Bounded integer, alias, whitespace, duplicate and pre-I/O budget checks.

These scopes do not certify other layouts, native error text or side effects,
all libc/ABI profiles, general graph topology, full canonical CI or production Workers.

## Linear syntax evidence and regeneration

- 18480 complete native raw outputs across all declared input/output formats,
  twenty-two lexical/option graph cases, two size conditions and default/scalar
  arithmetic, with an independent payload seed.
- Forty-five fresh native output/rejection cases cover quote layers, native
  unclosed quotes, protected space, last-wins fields and terminal separators.
- 2048 whole native CLI outputs, 256 actual Node outputs and sixteen dual-profile
  local workerd/R2 framecrc anchors include timing, EOF and staging cleanup.
- 1024 token vectors and 1024 option vectors record exact results from the primary
  reference build-directory libavutil archive; commit, flags, archive hash and
  oracle-source hashes identify their origin.

Regenerate the same recorded ASCII input corpus after building the primary native
reference, including its static libavutil archive:

```sh
node tools/differential-runner/filter-syntax/generate.mjs
npx vitest run tests/unit/video-filter-syntax.test.ts
```

The generator validates the reference commit, flags, main binary hash and native
execution platform, then records the linked archive identity. These vectors do
not certify a canonical toolchain, arbitrary Unicode/locale behavior or general
graph topology. Native libraries are confined to development; runtime parsing is
TypeScript. See the [component provenance](../../packages/avfilter/NOTICE).

## Labels, instances and declaration order

The declared one-input/one-output filters may be connected by labels across
comma/semicolon chains. `[x]scale=13:7[out];[in]hflip[x]` executes reflection before
scaling. A simple graph must have exactly one external input and output, and every
node must lie on the connected path. External pad names are retained without
restricting them to `in`/`out`, matching native simple-graph binding.

Pad matching searches unlinked current/later declarations in native order and
consumes each pad once. Label names may be reused after a link is consumed.
Unlabelled adjacency is applied only within its textual chain. Self-links, cycles,
disconnected paths, excess pads and multiple external streams fail preflight.

Execution follows the path while format negotiation keeps original declaration
registration order. Output sizing appends the final scale after the path. When
labels, instances or multiple chains are present, each parsed step exposes frozen
`graph` metadata: `declarationIndex`, `chainIndex` and optional `inputLabel`,
`outputLabel`, `instanceName`. `filter@name` and `filter@` retain the instance value;
filter-command handling remains incomplete. Unlabelled step shapes are preserved.

Evidence adds 10080 complete native raw outputs, 1152 declaration-permutation
outputs, 46 output/rejection cases, 2048 CLI outputs, 256 actual Node outputs and
sixteen dual-profile local workerd/R2 framecrc anchors. Branching filters, general
DAG scheduling, `-filter_complex`/label mapping, command dispatch, other layouts
and production-runtime conformance remain incomplete.

String descriptions follow UTF-8 argument transport for unpaired UTF-16 units;
replacement characters are introduced while BOM, valid pairs and Unicode
normalization differences are preserved. Labels are compared exactly after
lexical decoding.

## Transposition

`transpose` accepts `cclock_flip` (0, default), `clock` (1), `cclock` (2)
and `clock_flip` (3), through positional or named `dir` options. Declared
nonnegative decimal integer values are supported. The `passthrough` option
accepts `none` (0), `landscape` (1), `portrait` (2), or a nonnegative signed32
integer; other integer modes behave as none. Square geometry matches either
landscape or portrait. Legacy directions 4–7 select direction modulo four and
force landscape passthrough, overriding an explicit passthrough option.
General AVOption expressions remain incomplete. Invalid assignments fail when
applied, even if followed by a valid value; valid repeated options use the last
assignment. Existing quoting and label/instance parsing apply.

Transposition swaps width/height and preserves pixel components. Direct
`transposeVideoFrame` supports thirteen declared eight-bit layouts with equal
horizontal/vertical chroma subsampling. YUV422P requires graph auto-conversion
into a symmetric layout; the direct helper rejects it. Each subsampled plane
uses its own ceiling dimensions, including odd image sizes and alpha planes.
Positive padded input strides are accepted, output storage is owned and tight,
and frame/storage budgets and cancellation are checked. Negative input strides
and complete frame-property/sample-aspect-ratio compatibility are incomplete.

The graph planner retains native registration order for implicit input trim.
Rawvideo input `-ss`, `-t`, or `-to` adds a format-preserving negotiation node
after user filter registrations and before output sizing. This may place an
automatic conversion before transpose rather than after it. Temporal selection
continues to use the bounded bigint rawvideo time plan. Direct API plans use
`inputTrim: true` when modelling that CLI boundary.

Evidence: 520 direct native comparisons, 10080 graph comparisons, 288 geometry
cases, 38 option cases, 3584 CLI outputs, 256 Node outputs and sixteen dual-profile
local workerd/R2 anchors. These establish the stated scope; production Workers,
general expressions, other layouts and full filter conformance remain unverified.

An additional 20160 complete native raw outputs verify implicit input trim across
the existing reflection, scale and candidate-format graphs, fourteen source
formats, fifteen output conditions, four input time conditions, two output sizes
and default/scalar profiles. Existing CLI and local workerd regressions pass.

A separate 3360-case matrix compares complete raw output against the locked
Linux x86_64 default reference in the pinned, network-disabled container. It
covers fourteen sources, fifteen outputs, four transpose graphs, two sizes and
input-trim on/off with an independent payload. Canonical toolchain reproducibility
and complete platform conformance remain unverified.

Reproduce the Linux matrix or regenerate the dual-profile worker anchors from
the repository root after building the locked primary and Linux references:

```sh
npm run reference:transpose-linux
npm run reference:transpose-workers
```

Both commands validate reference provenance; Linux execution uses the pinned
container with networking disabled. The matrix writes raw comparison evidence
under `.build/linux-x64/transpose-matrix`; anchor generation updates
`compat/behavior-specs/transpose-worker.json`.
