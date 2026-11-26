# chromanr video filter

`chromanr` follows pinned `libavfilter/vf_chromanr.c` (FFmpeg 9.0.2,
`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). It is one registry descriptor,
`packages/avfilter/src/video-ops/chromanr.ts` (role `frame`), registered with one
import line and one array line in `video-ops/registry.ts`. Provenance is in
`packages/avfilter/NOTICE-CHROMANR`.

## Syntax

`chromanr[=thres:sizew:sizeh:stepw:steph:threy:threu:threv:distance]`, in the native
shorthand order.

| Option | Type | Accepted | Default |
|---|---|---|---|
| `thres` | float | decimal numbers (`30.5`, `1e2`, `.5e1`, `+77`) in [1, 200], range-checked as a double and stored as a float | 30 |
| `sizew`, `sizeh` | int | decimal or `0x` integers in [1, 100] | 5 |
| `stepw`, `steph` | int | decimal or `0x` integers in [1, 50] | 1 |
| `threy`, `threu`, `threv` | float | as `thres`, in [1, 200] | 200 |
| `distance` | int | `manhattan`, `euclidean`, `0`, `1` | `manhattan` |

Values outside a range fail before any output, as they do natively. These forms are
refused explicitly, before any output, although native accepts them:
expression values (`thres=20*2`, `sizew=2.5`, `distance=manhattan+1`), the
constants `min`, `max`, `default`, `none` and `all`, SI suffixes, `enable=` (native
supports generic timeline), and runtime commands (native has
`ff_filter_process_command`). The registry refuses runtime commands because the
descriptor sets neither `timeline` nor `geometryCommands`. Unknown options and
`threads` are refused too.

## Semantics

These follow `filter_frame` and the eight-bit slice functions. In 9.0.2,
`filter_frame` computes the thresholds that the scope attributes to
`config_input`. The result is the same.

- Each threshold is the stored float times `1 << (depth - 8)`, which is 1 here,
  truncated to int. So `thres=30.99` acts as 30 and `threu=10.5` as 10.
- If any of `threy`, `threu` or `threv` is below `200.f`, the `_e` slice is used:
  a sample must also satisfy `|dY| < threy`, `|dU| < threu` and `|dV| < threv`.
  All three take part even when only one of them was lowered.
- For each chroma sample (x, y), the window is rows `max(0, y-sizeh)` to
  `min(h-1, y+sizeh)` in steps of `steph`, and the same for columns with
  `sizew` and `stepw`. Steps start at the clipped window start. The luma value
  read for chroma position (xx, yy) is at (xx·chroma_w, yy·chroma_h).
- A window sample is accepted when its distance is below `thres`. Manhattan
  distance is the integer `|dY|+|dU|+|dV|`. Euclidean distance is `sqrtf` of the
  integer `dY²+dU²+dV²`, compared as a float with the integer threshold. The sum
  is below 2^24, so it is exactly representable, and `sqrtf` is correctly
  rounded. `Math.fround(Math.sqrt(n))` reproduces it.
- The sums start from the centre sample with a count of 1. The centre also lies
  in its own window, so it is counted twice. The output is
  `(sum + (count >> 1)) / count` in integer division, for U and V separately.
- Luma and alpha are copied. The output has owned, tight, positive-stride planes.
  PTS and metadata are copied, and the input is never mutated. Frame size, input
  storage, stride, plane count, time base and step validity are checked, and
  `AbortSignal` is checked once per chroma row.

## Formats

`formats()` is the native `pix_fmts` list in declared order: 41 formats, covering
planar YUV and YUVA at every depth, `yuvj` included. The shared negotiators
therefore pick what native picks. Frames run here in the eight-bit layouts with
frame storage (`yuv420p`, `yuv422p`, `yuv444p`, `yuva420p`) and, on linear chains,
in the legacy `yuvj420p`, `yuvj422p` and `yuvj444p` sources. nv12 and nv21 convert
to yuv420p as they do natively. rgb24, bgr24 and gbrp convert to yuv444p.

Some native picks have no frame storage here, and the negotiators refuse them at
plan time by name, on every path and before any output is opened:

- `gray` negotiates `yuvj444p`.
- `rgba`, `bgra`, `argb` and `abgr` negotiate `yuva444p`.

For this reason, the registry examples start with `format=yuv420p`, `format=yuv444p`
or `format=yuva420p`, since the registry test runs them from an 8x8 gray source.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`. The operator is stateless and
uses `frame` on every path. No `actorFrame` is needed.

## Determinism and arithmetic profile

The arithmetic is integer, except for `sqrtf` of an exact integer, which is
correctly rounded on every IEEE platform. There is no dependence on the pixel
arithmetic profile. Native slice threading splits the chroma rows and cannot
change the results. The tests show that native gives the same output with default
threads, with `-filter_threads 1` and with `-filter_threads 4`. No case is gated
by platform, and no macOS difference is expected. This has been measured on Linux
x86_64 only.

## Evidence

All counts are from runs against the sandbox build `.build/reference/ffmpeg` (Linux
x86_64, `--disable-x86asm`, commit 946fcce0; sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`; built with
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). The differential tests read
`.build/reference/build-metadata.json` and assert the commit and
`--disable-x86asm`. They do not pin a binary.

`tests/differential/video-chromanr.test.ts`:

- *matches native chromanr across formats, distances, window sizes, steps,
  thresholds and edge sizes on the linear and graph planners, with default and
  single filter threads*: 408 cases.
  - The cases are 4 formats × 6 sizes {1x1, 2x2, 5x3, 7x5, 8x6, 17x9} × 17 option
    sets: defaults, euclidean, window sizes 1 and 100 (clipped), 3x7, steps 2/3
    and 50, thresholds 1 and 200, `_e` threshold combinations, and fractional
    thresholds.
  - Each case has 4 frames: noise, a structured tile pattern, low-amplitude noise
    over ramps, and constant planes with an edge. The inputs use padded strides.
  - Each case is compared byte for byte with `compileVideoFilterChain` and with
    `compileVideoFilterGraph`. Native is run twice per case, with default threads
    and with `-filter_threads 1`, and the two outputs must agree: 816 native runs.
- *matches native chromanr on frames tall enough for several native slices, with
  default and single filter threads*: 24 cases (4 formats × {64x48, 33x41} × 3
  option sets). Each case runs native 3 times (`-threads 4 -filter_threads 4`,
  `-filter_threads 1` and the default), which must agree, and compares the result
  with the linear plan.
- *matches native chromanr rawvideo and framecrc CLI outputs on the linear, graph,
  stream, actor and timed paths, with and without output -ss/-t*: 160 CLI
  comparisons (4 formats × {5x3, 17x9} × 5 paths × rawvideo/framecrc × with and
  without `-ss 0.04 -t 0.05`). The paths are:
  - linear: `-vf` through `createMediaBackend`;
  - graph: `-filter_complex`;
  - stream: two-input `hstack`;
  - actor: `createTimedVideoBackend` with the `producer` scheduler;
  - timed: `createTimedVideoBackend` with the `pull` scheduler, behind
    `split`/`nullsink`.
- *matches native replayed chromanr branches frame by frame through
  createReplayVideoExecution*: 8 replay comparisons, including split/vstack
  branches.
- *matches native chromanr option acceptance and outputs, refusing expressions,
  named constants and timeline options explicitly*: 32 option strings. 17 are
  accepted by both with identical output, 10 are rejected by both, and 5 are
  accepted natively but refused here as out of scope.
- *refuses chromanr enable= and runtime commands before any output is opened,
  which native accepts*: 9 refusals. Three graphs (`enable=1`, `enable=gte(t,0)`
  and a `sendcmd` graph) are each run through three CLI backends: media, timed
  producer and timed pull. No output is opened in any of them. One further run
  shows that native accepts `enable=`.
- *negotiates every accepted source as native does and refuses picks without
  frame storage before output on every path*: `chromanr=thres=60` from 17 sources,
  with native's pick read from `showinfo`. 93 checks in total:
  - 12 sources match byte-exact (`-cpuflags 0`, scalar) on the five paths. The
    legacy yuvj sources run on linear chains only.
  - `gray` (yuvj444p) and the four packed-alpha sources (yuva444p) are refused by
    name on the five paths and on the four CLI backends.

Four mutations were tried on the kernel: no rounding term, `<=` instead of `<`
for the distance, a dropped `threy` check, and `stepw` used for rows. The planner
test caught each of them.

`tests/unit/video-chromanr.test.ts` (5 tests) covers:

- parsing and every refusal;
- hand-computed kernel values: the centre counted twice, rounding, threshold
  truncation, the `_e` checks, euclidean against manhattan, stepped clipped
  windows, and subsampled yuva420p with alpha copied;
- the declared format list and the negotiation refusals;
- `maxFrameBytes`, input storage, malformed strides and plane counts;
- settings validation, `AbortSignal` and unmutated input.

`tests/unit/video-operator-registry.test.ts` runs the three descriptor examples on
all five paths and checks that they agree.

## Proposed contracts

All of these are in `tests/differential/video-chromanr.test.ts`, with modes
semantic and bit-exact. None is gated by platform: they run on every platform.

| id | test title | scope |
|---|---|---|
| `filter.chromanr.planners` | matches native chromanr across formats, distances, window sizes, steps, thresholds and edge sizes on the linear and graph planners, with default and single filter threads | 4 formats × 6 sizes × 17 option sets × 4 patterned frames; linear and graph; native default vs `-filter_threads 1` |
| `filter.chromanr.threads` | matches native chromanr on frames tall enough for several native slices, with default and single filter threads | 4 formats × {64x48, 33x41} × 3 option sets; native 4/1/default filter threads agree |
| `filter.chromanr.cli-paths` | matches native chromanr rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths, with and without output -ss/-t | 4 formats × 2 sizes × 5 paths × rawvideo/framecrc × with/without `-ss`/`-t` |
| `filter.chromanr.replay` | matches native replayed chromanr branches frame by frame through createReplayVideoExecution | 4 formats × 2 replay graphs |
| `filter.chromanr.options` | matches native chromanr option acceptance and outputs, refusing expressions, named constants and timeline options explicitly | 32 option strings: 17 / 10 / 5 |
| `filter.chromanr.refusals` | refuses chromanr enable= and runtime commands before any output is opened, which native accepts | 3 graphs × 3 CLI backends, no output opened |
| `filter.chromanr.negotiation` | negotiates every accepted source as native does and refuses picks without frame storage before output on every path | 17 sources, 93 checks |

## Unsupported

- `enable=` timeline and runtime commands.
- Expression values, named constants and SI suffixes in options.
- Native picks without frame storage here: `yuvj444p` from gray, `yuva444p` from
  packed RGB with alpha, and every high-bit-depth, 4:4:0, 4:1:1, yuva422p and
  yuva444p format in the list. They are refused by name before any output.
- No H.264/MP4 framecrc comparison was made. The operator keeps the frame size, so
  the MP4 aspect derivation is unaffected.
