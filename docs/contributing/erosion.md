# erosion video filter

`erosion` follows the eight-bit `erosion` kernel of the pinned
`libavfilter/vf_neighbor.c` (FFmpeg 9.0.2, commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/erosion.ts`, and its provenance is in
`packages/avfilter/NOTICE-EROSION`. The kernel lives in that module; no
neighbourhood code is shared with dilation, deflate or inflate in this wave.

## Syntax

`erosion[=coordinates:threshold0:threshold1:threshold2:threshold3]`, with the
shorthand in native declaration order, or the same names as keys.

| Option | Range | Default | Meaning |
|---|---|---|---|
| `coordinates` | 0..255 | 255 | Mask of the eight neighbours, in native bit order: 1 up-left, 2 up, 4 up-right, 8 left, 16 right, 32 down-left, 64 down, 128 down-right. |
| `threshold0`..`threshold3` | 0..65535 | 65535 | Per-plane limit on how far a sample can drop. `0` copies the plane. |

Values are `AV_OPT_TYPE_INT` expressions (`filterIntegerOption`): `1+2`, `max`,
`min` and `default` are accepted, and fractions round half to even. Out-of-range
values, empty values, a sixth positional value and unknown keys are refused with
`VideoFilterParseError` before any output is opened.

Refused explicitly:

- `enable=` timeline expressions. Native has a generic timeline, but this
  descriptor sets no `timeline`.
- Runtime commands. `threshold*`, `coordinates`, `w` and `x` return ENOSYS (-38),
  and `enable` returns AVERROR_PATCHWELCOME from the disabled timeline.
- Generic filter-context options such as `threads`.
- Any plane one pixel wide, from `geometry` on every path and again in `frame`.
  This covers gray, yuv444p or gbrp with width 1, and yuv420p, yuv422p or
  yuva420p with width 1 or 2, whose chroma planes are then one pixel wide.
  Native `coordinateslb` reads column 1 there, past the end of the row.

## Semantics

For every plane with a non-zero threshold, each output sample is
`max(min(p, selected neighbours), max(p - threshold, 0))`. Native clamps after
each neighbour, which gives the same result because the limit is never above
`p`. At the top and bottom edges the neighbour rows clamp to the current row
(`nh`/`ph`). Column 0 mirrors its left neighbours onto column 1, and the last
column mirrors its right neighbours onto column `width-2`. These are the
`coordinateslb` and `coordinatesrb` tables. With width 2 the middle call is
empty. `threshold3` applies to the yuva420p alpha plane. gbrp thresholds follow
the memory plane order G, B, R.

Output planes are owned and tight, with positive strides. PTS (bigint) and
metadata are copied. Input planes are never mutated. Frame bytes and resident
input storage are bounded by `maxFrameBytes`. `AbortSignal` is checked per row.

## Formats and paths

`formats()` is the native list intersected with the negotiation table, in table
order: yuv420p, yuv422p, yuv444p, gray, yuva420p and gbrp. Other formats, such
as nv12 or packed RGB, get an automatic conversion during negotiation.

Paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is a
stateless `frame` role with no `actorFrame`, so actor and timed execution call
the same `frame` function.

Determinism: integer min/max only, with no floating point and no
platform-dependent arithmetic. Native slice threading does not change the
result.

## Evidence

All comparisons run the sandbox `.build/reference/ffmpeg` (Linux x86_64,
sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`) at
test time.

`tests/differential/video-erosion.test.ts`:

- `matches native erosion for every format, coordinate mask, per-plane threshold and size on the linear and graph planners`:
  3,024 byte comparisons. The matrix is 6 formats x 12 coordinate masks (255, 0, 85,
  170 and each of the 8 single bits) x 6 threshold sets (default, all 0, all
  10 and three mixed per-plane sets) x sizes 2x3, 3x3, 9x7 and 16x12. Width 2
  runs only for the three formats without horizontal subsampling. Each case
  has two frames, LCG noise and a block pattern, and is checked on both
  `compileVideoFilterChain` and `compileVideoFilterGraph`.
- `matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs`:
  576 whole-output byte comparisons. The matrix is 6 formats x 2 sizes x 4
  chains x {rawvideo, framecrc} x 6 executions: `-vf` (linear),
  `-filter_complex` (graph), two-input `-filter_complex` (stream), and the
  timed backend with the `activation` and `producer` schedulers (actor) and the
  `pull` scheduler (timed).
- `matches native replayed erosion branches frame by frame`: 24
  `createReplayVideoExecution` graphs, including split, hstack, transpose and
  nullsink branches, with rawvideo bytes and PTS checked.
- `refuses one pixel wide erosion planes on every path before opening outputs`:
  25 CLI refusals over 5 format/size cases x 5 paths, with no output opened,
  plus planner refusals. Native itself reads out of bounds in these cases, so
  there is no native comparison.

The differential inputs are already in the operator's formats, so no implicit
conversion runs. Mutating the border mirror or dropping the threshold floor
makes the first three tests fail.

`tests/unit/video-erosion.test.ts` covers option parsing, hand-computed kernel
results, budgets, malformed strides and storage, plane counts, time bases,
invalid steps, cancellation before and during a frame, linear and graph
budgeting, negotiation from nv12, and refusal of timeline and runtime commands.
The unchanged `tests/unit/video-operator-registry.test.ts` runs the four
descriptor examples on all five paths.

## Proposed test contracts

| id | file | test title | scope |
|---|---|---|---|
| `video.erosion-matrix` | tests/differential/video-erosion.test.ts | matches native erosion for every format, coordinate mask, per-plane threshold and size on the linear and graph planners | 3,024 linear and graph raw comparisons over the format, mask, threshold and size matrix |
| `video.erosion-cli` | tests/differential/video-erosion.test.ts | matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs | 576 rawvideo and framecrc CLI outputs on linear, graph, stream, actor and timed |
| `video.erosion-stream` | tests/differential/video-erosion.test.ts | matches native replayed erosion branches frame by frame | 24 replay graphs, raw bytes and PTS |
| `video.erosion-width-one` | tests/differential/video-erosion.test.ts | refuses one pixel wide erosion planes on every path before opening outputs | Explicit refusal, with no output opened, on all five paths |
| `video.erosion-options-api` | tests/unit/video-erosion.test.ts | parses native defaults, shorthand order, ranges and integer expressions into frozen steps | Parser and descriptor facts |
| `video.erosion-frame-api` | tests/unit/video-erosion.test.ts | erodes with mirrored borders, clamped rows, coordinate masks and thresholds into owned tight planes | Kernel semantics on hand-computed frames |
| `video.erosion-refusals` | tests/unit/video-erosion.test.ts | refuses one pixel wide planes, unsupported layouts, budgets, malformed storage, settings and cancellation explicitly | Limits and refusals |
| `video.erosion-plans` | tests/unit/video-erosion.test.ts | budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands | Plan budgeting, negotiation, command refusal |

## Unsupported

- `enable=` and every runtime command.
- Formats deeper than eight bits (`erosion16`), and every native format outside
  the negotiation table: yuva444p, yuv440p, yuvj*, yuv411p, yuv410p, gbrap and
  gray9-16. These reach the filter only through conversion to a listed format.
- Planes one pixel wide.
- H.264/MP4 framecrc input has no erosion comparison.
