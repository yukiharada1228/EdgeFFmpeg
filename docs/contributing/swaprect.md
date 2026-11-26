# swaprect video filter

`swaprect` follows pinned `libavfilter/vf_swaprect.c` (FFmpeg 9.0.2,
`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). It is one registry descriptor,
`packages/avfilter/src/video-ops/swaprect.ts` (role `frame`), registered with one
import line and one array line in `video-ops/registry.ts`. Provenance is in
`packages/avfilter/NOTICE-SWAPRECT`.

## Syntax

`swaprect[=w:h:x1:y1:x2:y2]`, with the native shorthand order. Every option is an
`AV_OPT_TYPE_STRING` expression, evaluated per frame as `av_expr_parse_and_eval`
does (a fresh evaluation context each time, so `st`/`ld` state does not persist).

| Option | Meaning | Default |
|---|---|---|
| `w`, `h` | rectangle size | `w/2`, `h/2` |
| `x1`, `y1` | first rectangle's top-left corner | `w/2`, `h/2` |
| `x2`, `y2` | second rectangle's top-left corner | `0`, `0` |

Variables: `w` and `h` (the frame size), `a` (`(float)w/h`, rounded to single
precision) and `t` (`pts * av_q2d(time_base)`, NaN without a pts).

Refused explicitly at parse time, before any output:

- expressions that do not parse (`w=`, `w=foo`, `w=1+`), as native fails at its first frame;
- expressions reading `n` (`frame_count_out`): no path carries the link frame counter;
- expressions reading `sar` or `dar`: the linear and frame-graph shapes carry no
  sample aspect ratio, and the timed executor runs the unnegotiated step, so the
  value cannot reach every flagged path (see [Shared edits needed](#shared-edits-needed));
- calls to `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`,
  `exp`, `pow`, `gauss`, `squish` and the `^` operator (JavaScript `Math`, not the
  reference libm), and `time` (the wall clock);
- `enable=` (native supports the generic timeline), `threads` and unknown options.
  Runtime commands are refused by the registry (no `timeline`, no `geometryCommands`).

Refused at plan time on the `linear`, `graph` and `stream` paths: expressions reading
`t` (`Swaprect t expressions are implemented on the actor and timed paths only`). Those
CLI paths hand the operator timestamps that differ from native under `-ss`: the media
`-vf` chain sees timestamps already shifted by an output `-ss`, and the media
`-filter_complex` graph sees unshifted timestamps after an input `-ss`; native's filter
sees the opposite in both cases. The descriptor's `geometry` runs only in those
negotiators, so the refusal is raised there; `timedGeometry` serves the actor and
timed paths, which deliver native timestamps and accept `t`.

Accepted forms include arithmetic, comparisons (`lt`, `gte`, `if`, `between`, ...),
`min`, `max`, `abs`, `trunc`, `floor`, `ceil`, `round`, `sqrt`, `st`/`ld`, SI
suffixes and the ported `log`, `exp2`/`dB` and `hypot` (Linux profile).

## Semantics

Per frame, exactly as `filter_frame` does:

1. Each expression is evaluated in double and converted to `int` by truncation. NaN
   (native's evaluator itself fails with EINVAL), infinities and values outside `int`
   are refused (`outside int`): the native conversion is undefined behaviour, and the
   reference binary faults on them. `w` or `h` equal to `INT_MIN` is refused because
   `AV_CEIL_RSHIFT` negates it.
2. `x1`, `y1`, `x2`, `y2` are clipped to `[0, w-1]` and `[0, h-1]`.
3. The unclamped plane sizes `aw`, `ah` are computed with `AV_CEIL_RSHIFT` (chroma
   planes 1 and 2 by `log2_chroma_w/h`), then `w = min(w, W-x1, W-x2)` and
   `h = min(h, H-y1, H-y2)` give `pw`, `ph`. Plane positions are `x >> log2_chroma_w`.
4. A plane swaps only when `pw == aw` and `ph == ah`; so a rectangle clamped at an edge
   swaps nothing, except where chroma rounding hides the clamp (w=4 at x1=1 on a
   4-wide yuv420p frame swaps only the chroma planes). Zero and negative heights copy
   no rows; a negative width with a positive height is a negative `memcpy` natively and
   is refused (`negative widths`).
5. Rows are swapped in place from the top with native's sequence (copy the first
   rectangle's row to a temporary, `memmove` the second onto it, copy the temporary to
   the second), so overlapping rectangles give native's bytes. Offsets use
   `av_image_fill_max_pixsteps` (3 for rgb24/bgr24, 4 for packed RGBA, 2 for the
   interleaved nv12/nv21 chroma plane, 1 otherwise) and `av_pix_fmt_count_planes`.

Time-independent expressions are evaluated once at plan time with the negotiated
geometry, so their refusals surface before any output on every path. A `t`-dependent
refusal (for example `w=t` without timestamps) can only surface at the frame that
produces it.

The output is owned, tight, positive-stride planes (native's `NEEDS_WRITABLE` copy);
PTS and metadata are copied and the input is never mutated. Frame size, input storage,
strides, plane count, time base and `AbortSignal` (per row) are checked like the other
frame operators.

## Formats

`formats()` is `ff_formats_pixdesc_filter(0, PAL | HWACCEL | BITSTREAM)` in
AVPixelFormat order: every negotiable format except `monow`, `monob`, `pal8`, `bgr4`,
`rgb4`, `xv30be` and `v30xbe` (244 of 251 formats). Every executable source therefore keeps
its own format, and frames run in the 14 layouts with storage (`yuv420p`, `rgb24`,
`bgr24`, `yuv422p`, `yuv444p`, `gray`, `nv12`, `nv21`, `argb`, `rgba`, `abgr`, `bgra`,
`yuva420p`, `gbrp`) plus the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear
chains. A negotiation that picks any other member is refused by name by the shared
negotiators.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all through `frame`. `t` is refused on
the first three (above).

## Determinism and arithmetic profile

Expressions are evaluated with the shared `compileExpression`/`evaluateExpression` and
the `linux-x64` numeric profile, then the swap is integer copies. The accepted
expression forms are platform-independent except `log`, `exp2`/`dB` and `hypot`, whose
`linux-x64` kernels reproduce glibc 2.36; the differential tests use arithmetic and
comparisons only, so no case is Linux-gated. `a` is single-precision (`Math.fround`), as
the native `(float)` cast; `t` multiplies the int64 pts converted to double by `num/den`.

## Evidence

Against `.build/reference/ffmpeg` built in the sandbox on Linux x86_64 from commit
946fcce0 with `--disable-x86asm` (sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). The test asserts the commit and the flag
from `build-metadata.json`; it never pins the digest.

- `tests/differential/video-swaprect.test.ts`
  - *matches native swaprect on every executable format and size, frame by frame on the linear and graph planners*:
    1260 native runs (14 formats x 6 sizes {1x1, 2x2, 5x3, 7x5, 8x6, 17x9} x 15 option
    strings: defaults, unit swaps, same-row, same-column and diagonal overlaps, whole-frame,
    edges and clamping, negative and past-the-edge coordinates, zero and negative sizes,
    comparisons and `a`, fractional values), each with a noise frame, a ramp-and-edge frame
    and a constant-plane frame, padded strides, compared byte for byte on both
    `compileVideoFilterChain` and `compileVideoFilterGraph`.
  - *matches native swaprect rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths, with and without -ss and -t*:
    840 CLI comparisons (14 formats x {7x5, 8x6} x 5 paths x rawvideo/framecrc x {none,
    input `-ss 0.04` with output `-t 0.05`, output `-ss 0.04 -frames:v 1`}): `-vf`
    (linear), single-input `-filter_complex` (graph), two-input `hstack` (stream), and
    the timed backend with the `producer` (actor) and `pull` (timed) schedulers; the
    actor and timed cases use `t`.
  - *matches native t-dependent swaprect expressions on the actor and timed paths at every size, with and without -ss and -t*:
    648 CLI comparisons (6 formats x 6 sizes x 3 t-dependent graphs on the `producer`,
    `activation` and `pull` schedulers x rawvideo/framecrc x the three time variants).
  - *matches native replayed swaprect branches frame by frame through createReplayVideoExecution*: 28 replay comparisons (14 formats x 2 graphs including split/vstack).
  - *matches native option acceptance and outputs, refusing n, t on scoped paths, sar, dar, unported functions, timelines and native faults explicitly*:
    38 option strings: 17 accepted with identical output, 7 rejected by both, 4 on which
    native faults with a signal (`w=1/0`, `w=3e9`, negative widths with positive heights)
    and which are refused here, 10 accepted natively but refused here as out of scope
    (`enable`, `threads`, `n`, `t` on linear, `sin`, `^`, `exp`, `time`, `sar`, `dar`).
  - *refuses t on the scoped CLI paths and time-independent native faults on every path before any output is committed*: 8 CLI refusals on the media and timed backends.
  - *negotiates every accepted source as native does on every path*: `swaprect=3:2:1:1:4:3` from 17 sources; every source keeps its own format, byte-exact on the five paths (yuvj on linear chains): 73 checks.
- `tests/unit/video-swaprect.test.ts`: parsing, every refusal, variable detection,
  clamping and chroma rounding, plane selection, overlap order, packed and semi-planar
  steps, formats, plan-time refusals per path, budgets, malformed strides, time bases,
  `AbortSignal`, owned output and unmutated input (6 tests).
- `tests/unit/video-operator-registry.test.ts` runs the three descriptor examples on all
  five paths and checks they agree.

No macOS run was made. No H.264/MP4 framecrc comparison was made; the operator keeps
the frame size.

## Proposed contracts

| id | file | name | modes | scope |
|---|---|---|---|---|
| `filter.swaprect.planners` | `tests/differential/video-swaprect.test.ts` | matches native swaprect on every executable format and size, frame by frame on the linear and graph planners | semantic, bit-exact | 14 formats x 6 sizes x 15 option strings, 3 frames, padded strides, rawvideo bytes |
| `filter.swaprect.cli-paths` | `tests/differential/video-swaprect.test.ts` | matches native swaprect rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths, with and without -ss and -t | semantic, bit-exact | 14 formats x 2 sizes x 5 paths x rawvideo/framecrc x 3 time variants |
| `filter.swaprect.time` | `tests/differential/video-swaprect.test.ts` | matches native t-dependent swaprect expressions on the actor and timed paths at every size, with and without -ss and -t | semantic, bit-exact | 6 formats x 6 sizes x 3 t-dependent graphs on producer/activation/pull x rawvideo/framecrc x 3 time variants |
| `filter.swaprect.stream` | `tests/differential/video-swaprect.test.ts` | matches native replayed swaprect branches frame by frame through createReplayVideoExecution | semantic, bit-exact | 14 formats x 2 replay graphs |
| `filter.swaprect.options` | `tests/differential/video-swaprect.test.ts` | matches native option acceptance and outputs, refusing n, t on scoped paths, sar, dar, unported functions, timelines and native faults explicitly | semantic | 38 option strings on yuv420p 9x7 |
| `filter.swaprect.refusals` | `tests/differential/video-swaprect.test.ts` | refuses t on the scoped CLI paths and time-independent native faults on every path before any output is committed | semantic | 8 CLI refusals |
| `filter.swaprect.negotiation` | `tests/differential/video-swaprect.test.ts` | negotiates every accepted source as native does on every path | semantic, bit-exact | 17 sources, 73 checks |

None is platform-gated.

## Unsupported

- `n`, `sar` and `dar` in expressions; `t` on the linear, graph and stream paths.
- Unported libm functions, `^` and `time`.
- `enable=` timeline, `threads` and runtime commands.
- Values that native converts with undefined behaviour or faults on (NaN, infinities,
  outside `int`, negative widths with positive heights that swap).
- Native formats without frame storage here (high bit depth, packed 4:2:2, palettes are
  already excluded natively): any negotiation that picks one is refused by name.

## Shared edits needed

- Media `-vf` (linear) CLI with an output `-ss`: the filter chain receives timestamps
  already shifted by the seek; native filters see the original timestamps and trims
  afterwards. Fixing it would let `t` run on the linear path.
- Media `-filter_complex` (graph) CLI with an input `-ss`: the graph receives the
  demuxed timestamps without the input seek offset that native applies before
  filtering. Fixing it would let `t` run on the graph and stream paths.
- `VideoShape` in the linear and frame-graph negotiators carries no sample aspect ratio,
  and `packages/avformat/src/actor-video/execute.ts` runs `graph.nodes[].configuration`
  rather than the negotiated step that `timedGeometry` may return. Both are needed for
  `sar`/`dar` on every path.
