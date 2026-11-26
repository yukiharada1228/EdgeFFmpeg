# median video filter

`median` follows the eight-bit kernel of the pinned `libavfilter/vf_median.c`
and `libavfilter/median_template.c` (FFmpeg 9.0.2, commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/median.ts`, the kernel is
`packages/avfilter/src/video-median.ts`, and the provenance is in
`packages/avfilter/NOTICE-MEDIAN`.

## Syntax

`median[=radius:planes:radiusV:percentile]`, with the shorthand in native
declaration order, or the same names as keys.

| Option | Type | Range | Default | Meaning |
|---|---|---|---|---|
| `radius` | INT | 1..127 | 1 | Horizontal radius. |
| `planes` | INT | 0..15 | 15 | Mask of filtered planes in memory order (gbrp: G, B, R). Other planes are copied. |
| `radiusV` | INT | 0..127 | 0 | Vertical radius; 0 means `radius`. |
| `percentile` | FLOAT | 0..1 | 0.5 | Rank of the selected sample. |

`radius`, `planes` and `radiusV` are `AV_OPT_TYPE_INT` expressions
(`filterIntegerOption`: `1+2`, `min`, `max`, `default`, fractions round half to
even). `percentile` accepts a decimal literal (with an optional exponent); the
double is range-checked against [0, 1] and stored as float (`Math.fround`), as
`write_number` does. Expressions for `percentile` are refused explicitly.
Out-of-range values, empty values, a fifth positional value and unknown keys are
refused with `VideoFilterParseError` before any output is opened.

Refused explicitly:

- `enable=` timeline expressions (native has a generic timeline; this descriptor
  sets no `timeline`).
- Runtime commands. `radius`, `planes`, `radiusV`, `percentile` and `w` return
  ENOSYS (-38); `enable` returns AVERROR_PATCHWELCOME from the disabled timeline.
- Generic filter-context options such as `threads`.
- Filtered planes whose width plus the clipped radius exceeds 65534 samples, from
  `geometry` on every path and again in `frame`: native's `luc` column cursors
  are `uint16_t` and would wrap. There is no native comparison for this case.

## Semantics

`config_input` sets `radiusV = radiusV || radius`, then `check_params` walks the
filtered planes in order and clips `radius` to `(planewidth-1)/2` and `radiusV`
to `(planeheight-1)/2` whenever a plane is narrower than `2*radius+1` or shorter
than `2*radiusV+1`. Native only warns there, so every frame size is accepted,
down to 1x1 (radius 0). Unfiltered planes never clip the radii. The threshold is
`t = (int)((2*r*rv + rv + r) * 2.f * percentile)`, a float product truncated
once; `((2r+1)(2rv+1)-1)` is exact in float, so the only rounding is the single
product with the float percentile.

`filter_plane` is ported as one slice job: per-column fine (256 bins) and coarse
(16 bins) `uint16` histograms over rows clamped to the plane, a sliding coarse
row histogram over columns clamped to the plane, and lazily refreshed fine
segments (`luc`). The output is the first value whose running count exceeds `t`,
which is element `t` of the sorted clamped `(2r+1)x(2rv+1)` window. Native's
slice threads start their histograms at `slice_start - radiusV - 1`, and
`nb_threads <= planeheight[1]/(radiusV+1)` keeps that row inside the plane, so
threading never changes the result (checked against native with default threads
and `-filter_threads 1`). The `av_assert0` searches are repeated as
`VideoMedianError`s and are unreachable for valid steps.

Output planes are owned and tight, with positive strides. PTS (bigint) and
metadata are copied. Input planes are never mutated. Frame bytes and resident
input storage are bounded by `maxFrameBytes`. Each filtered plane allocates a
transient `544 * planewidth` byte histogram scratch (as native does per thread),
which is not part of `maxFrameBytes`. `AbortSignal` is checked per row and every
4096 columns.

## Formats and paths

`formats()` is the native `vf_median.c` list in declared order (56 formats,
`yuvj` and `gbrap` included), so the shared negotiators pick exactly what native
picks. Frames run in the eight-bit layouts with frame storage, gray, yuv420p,
yuv422p, yuv444p, yuva420p and gbrp, and in the legacy yuvj420p/yuvj422p/yuvj444p
sources of linear chains. nv12 and nv21 convert to yuv420p, rgb24 and bgr24 to
gbrp, as natively. Packed RGB with alpha (rgba, bgra, argb, abgr) converts to
`gbrap` natively, which has no frame storage here; the negotiators refuse it at
plan time with `Video filter median input negotiates gbrap, which is not
implemented`, on every path and before any output is opened.

Paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is a
stateless `frame` role with no `actorFrame`.

Determinism and arithmetic profile: integer histograms with `uint16` wrap
semantics (`Uint16Array`), plus the one float32 product for `t`, computed once
per plan with `Math.fround`. No platform-dependent arithmetic, so every case runs
on every platform; there are no linux-gated cases.

## Evidence

All comparisons run the sandbox `.build/reference/ffmpeg` at test time (Linux
x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). The first differential test reads
`.build/reference/build-metadata.json` and asserts commit 946fcce0 and
`--disable-x86asm`. Inputs are generated at test time in the operator's own
formats (no implicit conversion), three frames each: LCG noise, ramps with a
vertical edge and impulses, and constant planes.

`tests/differential/video-median.test.ts`:

- `runs the sandbox reference build of commit 946fcce0 without x86 assembly`.
- `matches native median for every format, radius, vertical radius, percentile, plane mask and small size on the linear and graph planners`:
  1,176 raw comparisons: 6 formats x 7 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9,
  15x15) x 14 filters (radius 1, 2, 7 and 127, distinct radiusV both ways,
  percentile 0, 0.25, 0.3, 0.5, 0.7 and 1, planes masks 0, 1, 6, 9 and 15) x
  {linear, graph}. Sizes near `2r+1` and below it exercise the radius clipping.
- `matches native median with default filter threads and with -filter_threads 1 on sliced frames`:
  60 native default-threads vs `-filter_threads 1` agreements and 60 linear
  comparisons (6 formats x 64x48 and 97x90 x 5 filters).
- `matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs with and without -ss and -t`:
  1,728 whole-output comparisons: 6 formats x 5x3 and 17x9 x 4 chains x
  {rawvideo, framecrc} x 6 executions (`-vf` linear, `-filter_complex` graph,
  two-input stream, timed activation and producer schedulers for actor, pull for
  timed) x 3 timings (none; input `-ss 0.04` with output `-t 0.05`; output
  `-ss 0.04 -frames:v 1`).
- `matches native replayed median branches frame by frame`: 24
  `createReplayVideoExecution` graphs (split, hstack, transpose, nullsink), raw
  bytes and PTS.
- `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path`:
  17 sources, 13 byte-exact on every path (yuvj on linear chains), 4 refused
  naming `gbrap` on the five paths and four CLI backends (89 checks).

Mutating the threshold formula, the initial column histogram or the radius
clipping makes the matrix test fail.

`tests/unit/video-median.test.ts` covers option parsing and float storage, radius
clipping and threshold values, the kernel against a brute-force sorted window on
eight size/radius/percentile cases, hand-computed frames, plane masks,
unsupported layouts, the wide-plane refusal, budgets, malformed strides and
storage, plane counts, time bases, invalid steps, cancellation before and during
a frame, linear and graph budgeting, negotiation from nv12 and the refusal of the
timeline and runtime commands. The unchanged
`tests/unit/video-operator-registry.test.ts` runs the five descriptor examples on
all five paths.

## Proposed test contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| `video.median-reference` | tests/differential/video-median.test.ts | runs the sandbox reference build of commit 946fcce0 without x86 assembly | Reference identity | all |
| `video.median-matrix` | tests/differential/video-median.test.ts | matches native median for every format, radius, vertical radius, percentile, plane mask and small size on the linear and graph planners | 1,176 linear and graph raw comparisons | all |
| `video.median-threads` | tests/differential/video-median.test.ts | matches native median with default filter threads and with -filter_threads 1 on sliced frames | Native thread agreement and 60 comparisons | all |
| `video.median-cli` | tests/differential/video-median.test.ts | matches native rawvideo and framecrc bytes through the -vf, -filter_complex and timed backend CLIs with and without -ss and -t | 1,728 CLI outputs on the five paths | all |
| `video.median-stream` | tests/differential/video-median.test.ts | matches native replayed median branches frame by frame | 24 replay graphs | all |
| `video.median-negotiation` | tests/differential/video-median.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | Native picks from 17 sources | all |
| `video.median-options-api` | tests/unit/video-median.test.ts | parses native defaults, shorthand order, ranges, integer expressions and the float percentile into frozen steps | Parser and descriptor facts | all |
| `video.median-plan-api` | tests/unit/video-median.test.ts | clips the radii to filtered planes and truncates the float threshold as config_input does | Radius clipping and threshold | all |
| `video.median-frame-api` | tests/unit/video-median.test.ts | selects the clamped window order statistic through the column histograms into owned tight planes | Kernel semantics | all |
| `video.median-refusals` | tests/unit/video-median.test.ts | refuses unsupported layouts, wide planes, budgets, malformed storage, settings and cancellation explicitly | Limits and refusals | all |
| `video.median-plans` | tests/unit/video-median.test.ts | budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands | Plans, negotiation, commands | all |

## Unsupported

- `enable=` and every runtime command.
- Formats deeper than eight bits, and every native format without frame storage
  here (yuva444p, yuva422p, yuv440p, yuvj440p, yuvj411p, yuv411p, yuv410p, gbrap,
  gray9-16 and the high-depth YUV/GBR formats). A negotiation that picks one, such
  as packed RGB with alpha (`gbrap`), is refused by name before output.
- Non-decimal `percentile` expressions.
- Filtered planes wider than `65534 - radius` samples.
