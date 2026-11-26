# edgedetect video filter

`edgedetect` follows pinned `libavfilter/vf_edgedetect.c` with the eight-bit kernels
of `edge_template.c` (`ff_gaussian_blur_8`, `ff_sobel_8`) and `edge_common.c`
(`get_rounded_direction`, `ff_non_maximum_suppression`, `ff_double_threshold`).
For each selected plane:

1. **Blur.** A 5x5 Gaussian (sigma 1.4, weights summing to 159, integer division).
   Rows and columns outside `[2, n-2)` are copied unchanged, so a plane smaller
   than 5 in a dimension is copied along it. 1- and 2-sample planes are handled
   exactly as the native `FFMIN(n, 2)` heads and `n - 2` tails do: no read or
   write leaves the plane.
2. **Sobel.** Interior samples only. The gradient is `|gx| + |gy|` (16 bit), and
   the direction is rounded with the 16.16 fixed-point tangents 27146 and 158218.
   Border gradients stay zero, as native's `av_calloc`'d buffer never writes them;
   border directions are never read.
3. **Non-maximum suppression** into a zeroed plane, clipped to 0..255.
4. **Double threshold.** A sample above `high_u8` is kept. An interior sample above
   `low_u8` is kept when one of its eight suppressed neighbours is above `high_u8`
   (one pass, no recursive hysteresis). Everything else is 0.
5. **colormix** only: `(edge + input) >> 1`.

Unselected planes are copied. Output planes are owned and tight; the filter is
stateless across frames (the native per-plane buffers carry no value from one
frame to the next).

The descriptor is `packages/avfilter/src/video-ops/edgedetect.ts`, the kernel
`packages/avfilter/src/video-edgedetect.ts`, registered with one import line and one
array line in `video-ops/registry.ts`. `edgedetectVideoFrame` checks
`maxFrameBytes`, input plane storage, strides, the plane count, the time base and
the `AbortSignal` (per row of each stage). Its transient scratch is five bytes per
sample of the largest plane.

## Syntax

`edgedetect[=high[:low[:mode[:planes]]]]`, or named keys. Repeated keys keep the
last value.

| Option | Native type | Accepted here |
|---|---|---|
| `high` | `AV_OPT_TYPE_DOUBLE` 0..1, default 50/255 | Literals (`0.2`, `1e-1`), `+ - * /`, parentheses and the `default`/`min`/`max`/`none`/`all` constants, evaluated through the shared expression engine. Out of range fails. |
| `low` | as `high`, default 20/255 | as `high` |
| `mode` | `AV_OPT_TYPE_INT` 0..2, unit `mode`, default `wires` | `wires`, `colormix`, `canny`, integers and integer expressions over them (the shared integer-option helper, `llrint` rounding). |
| `planes` | `AV_OPT_TYPE_FLAGS`, unit `flags`, default 7 | `+`/`-` folded terms, each `y`, `u`, `v`, `r`, `g`, `b` (y=g=1, u=b=2, v=r=4) or a decimal/hex integer up to 4294967295. As in `write_number`, the declared 1..7 range is not enforced for flags: `planes=0` copies every plane. Only bits 0..2 select planes. |

`init` converts both thresholds with `(uint8_t)(x * 255. + .5)`; the step stores
`highU8` and `lowU8`. `high` may be below `low`: native semantics are kept.

Refused before any output is opened:

- out-of-range `high`, `low` and `mode` (native `out of range`), unknown `mode`
  names and `planes` terms (native `Unable to parse`), unknown options (native
  `Option not found`) and a fifth positional value (native `No option name`);
- threshold expressions with functions, `^` or other constants (`PI`, `E`, SI
  suffixes): native accepts them, but they are outside this scope, and `pow`
  and transcendental functions are not IEEE-exact across platforms;
- `enable=` and generic options such as `threads`;
- runtime commands: the descriptor sets neither `timeline` nor `geometryCommands`.

## Formats and paths

`formats(step)` returns the native `query_formats` list of the step's mode, in
declared order:

| Mode | Native list |
|---|---|
| `wires` | gray |
| `colormix` | gbrp, gray |
| `canny` | yuv420p, yuv422p, yuv444p, gbrp, gray |

Every member has frame storage here, so the shared negotiators pick exactly what
native picks and nothing is refused by name. Inputs outside the list are converted
as native converts them (for example yuva420p and nv12 to yuv420p and packed RGB to
gbrp under `canny`; everything but gray to gbrp under `colormix`; everything to
gray under `wires`). `geometry` refuses a negotiated format outside the mode's list
(an internal check), and `frame` repeats it. The size is unchanged.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is
stateless, so the actor and timed executors call `frame` directly.

## Determinism

Integer arithmetic only in the kernel. The two threshold conversions are IEEE
double products of exactly evaluated arithmetic, identical on every platform. No
case is gated by platform. Native `edgedetect` has no slice threading; the
differential file checks that native output is the same with default threads and
with `-filter_threads 1`.

## Evidence

`tests/differential/video-edgedetect.test.ts` asserts that
`.build/reference/build-metadata.json` names commit 946fcce0 and `--disable-x86asm`,
then runs `.build/reference/ffmpeg` (`-cpuflags 0`) at test time. Inputs are in the
operator's own formats. The option matrix has 46 (format, description) pairs:
8 wires sets on gray, 4 colormix sets on gbrp and gray, and 6 canny sets on the 5
canny formats. They cover defaults, `high=0:low=0`, `high=1:low=1`, swapped
thresholds (`high` below `low`), `low=0:high=1`, numeric, named and relative plane
masks (`planes=u+v` on gray, `planes=-y`, `planes=b`, `planes=g+r`) and the
`50/255` arithmetic form. Inputs have 3 frames of LCG noise, ramps with hard
vertical and diagonal edges, or constant planes.

| Test | Comparisons |
|---|---|
| `runs against a reference built from commit 946fcce0 with --disable-x86asm` | provenance of the sandbox build |
| `matches native edgedetect through the linear, frame graph and replay APIs across modes, formats, thresholds, planes, sizes and patterns` | 828 native rawvideo outputs (46 pairs x sizes 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 x 3 patterns), each matched byte for byte by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution` (2484 path comparisons). More than half the outputs are nonzero. |
| `matches native edgedetect rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t` | 2760 native rawvideo and framecrc outputs (46 pairs x 6 size/pattern/scope cases x 2 muxers x 5 paths) matched through the CLI frontend: `-vf` (linear), single-input `-filter_complex` (graph), multi-input `-filter_complex` (stream), the timed backend's `producer` (actor) and `pull` (timed) schedulers. Scopes: none, input `-ss 0.04` with output `-t 0.05`, and output `-ss 0.04 -t 0.05`. |
| `accepts the native option forms it implements with native bytes: unit names, relative and wide plane flags, constants and arithmetic` | 12 accepted option forms (`mode=canny-1`, `mode=wires+2`, `planes=y+u-y`, `+y`, `0`, `0x10`, `4294967295`, `8+v`, `default*2`, `max`, `1e-1`, `(1+2)/20`, last-wins keys, the 0.5/255 rounding edge) matched on 17x9 inputs. |
| `produces the same native output with default filter threads and with -filter_threads 1` | 46 native pairs agree. |
| `fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path` | 35 failures on both sides (7 option errors x 5 paths), with the native diagnostic checked and no output opened. |
| `negotiates every accepted source as native does for <vf>` (3 tests) | `edgedetect`, `edgedetect=mode=colormix:high=0.3` and `edgedetect=mode=canny:low=0.05:planes=y+u` from the 17 sources of `tests/helpers/video-negotiation-cases.ts`; native's pick is read from showinfo and every source runs byte-exact on the five paths (yuvj sources on linear chains). 73 checks each, 219 in all. |

The file takes about 33 s on 4 vCPUs with `--maxWorkers=1`. It ran in a Linux x64
sandbox against a reference built there (`npm run reference:build`, not the pinned
binary): ffmpeg sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, under Node v22.23.5 (Node 24 could
not be installed in the sandbox).

`tests/unit/video-edgedetect.test.ts` covers parsing and every refusal, the
`low_u8`/`high_u8` rounding edges, the per-mode format lists, hand-computed 3x3,
2x2, 1x1 and yuv420p cases (wires, colormix, `planes=0`, an unselected plane),
budgets, malformed strides, plane counts, the time base, invalid settings,
`AbortSignal`, an unmutated input, owned output planes, per-mode negotiation on the
linear path and the actor refusal of `enable=`. `tests/unit/video-operator-registry.test.ts`
runs the descriptor examples on all five paths.

## Proposed contracts

All for `filter.edgedetect`, on every platform (no gating):

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.edgedetect.api` | `tests/differential/video-edgedetect.test.ts` | `matches native edgedetect through the linear, frame graph and replay APIs across modes, formats, thresholds, planes, sizes and patterns` | linear, graph and stream API bytes |
| `filter.edgedetect.cli` | `tests/differential/video-edgedetect.test.ts` | `matches native edgedetect rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t` | five CLI paths, rawvideo and framecrc |
| `filter.edgedetect.options` | `tests/differential/video-edgedetect.test.ts` | `accepts the native option forms it implements with native bytes: unit names, relative and wide plane flags, constants and arithmetic` | option forms |
| `filter.edgedetect.threads` | `tests/differential/video-edgedetect.test.ts` | `produces the same native output with default filter threads and with -filter_threads 1` | native thread invariance |
| `filter.edgedetect.refusals` | `tests/differential/video-edgedetect.test.ts` | `fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path` | option errors on five paths |
| `filter.edgedetect.negotiation.wires` | `tests/differential/video-edgedetect.test.ts` | `negotiates every accepted source as native does for edgedetect` | per-source negotiation, 17 sources, 73 checks |
| `filter.edgedetect.negotiation.colormix` | `tests/differential/video-edgedetect.test.ts` | `negotiates every accepted source as native does for edgedetect=mode=colormix:high=0.3` | per-source negotiation, 17 sources, 73 checks |
| `filter.edgedetect.negotiation.canny` | `tests/differential/video-edgedetect.test.ts` | `negotiates every accepted source as native does for edgedetect=mode=canny:low=0.05:planes=y+u` | per-source negotiation, 17 sources, 73 checks |

## Unsupported

- The `enable=` timeline, runtime commands and generic filter options.
- Threshold expressions with functions, `^`, or constants other than
  `default`/`min`/`max`/`none`/`all`.
- `planes` terms that are expressions rather than unit names or integers.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged, so
  the `mp4-h264.ts` aspect derivation is unaffected.
