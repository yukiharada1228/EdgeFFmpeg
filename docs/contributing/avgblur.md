# avgblur video filter

`avgblur` follows `config_input`, `build_lut`, `averageiir2d` and the `FILTER` kernel (`filter_lut8`/`filter_slow8`) of the pinned `libavfilter/vf_avgblur.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Each selected plane is box blurred over `(2*radiusV+1) x (2*radius+1)` samples with replicated edges, as a vertical running column sum followed by a horizontal running row sum, and the sum is divided by the area with truncation. The descriptor and kernel live in `packages/avfilter/src/video-ops/avgblur.ts`. Provenance is in `packages/avfilter/NOTICE-AVGBLUR` (the upstream file is MIT-licensed; its notice is reproduced there).

## Syntax

`avgblur[=sizeX[:planes[:sizeY]]]`, or the same names as `key=value` pairs (names are case-sensitive, as in native).

| Option | Range | Default | Meaning |
|---|---|---|---|
| `sizeX` | 1..1024 | 1 | Horizontal radius. |
| `planes` | 0..15 | 15 | Bit mask of data planes to blur; the others are copied. For gbrp the bits follow data order G, B, R. |
| `sizeY` | 0..1024 | 0 | Vertical radius; `0` takes `sizeX`. |

Values are parsed as `AV_OPT_TYPE_INT`: expressions (hex such as `0xe` included) with the constants `default`, `min`, `max`, `none` and `all`, range checked, ties rounded to even (`filterIntegerOption`, linux-x64 profile).

Refused before any output is opened:

- out-of-range or invalid values;
- `enable=` (`Avgblur timeline expressions are not implemented`); native accepts it (`AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC`);
- every other option, including `threads`, and more than three positional values.

Runtime commands are refused, because the descriptor sets neither `timeline` nor `geometryCommands`: `sizeX`, `planes`, `sizeY` and `w` return ENOSYS and `enable` returns `AVERROR_PATCHWELCOME`. Native accepts `sizeX`, `planes` and `sizeY` through `process_command`.

## Radius resolution and edges

As in `config_input`, `sizeY=0` becomes `sizeX`, then both radii are clipped once to half of plane 1: `radius = min(planewidth[1]/2, sizeX)` and `radiusV = min(planeheight[1]/2, sizeY)`. Plane 1 is the chroma plane for YUV formats and the full frame for gray and gbrp, and the clipped radii apply to every plane, luma included. So yuv420p of width 1 or 2 has chroma width 1 and blurs no plane horizontally, and `sizeX=64` on a 17-pixel gray row uses radius 8. The clipped radii never exceed the plane, so no case reads outside it and no size is refused.

Edges replicate: the column sums for `x < 0` and `x >= width` use columns 0 and `width-1`, and the vertical update adds row `min(y+radiusV, h-1)` and subtracts row `max(y-radiusV-1, 0)`, exactly as the `syp`/`syn` offsets do. `LUT_DIV` (`lut[i] = floor(i/area)`, used while `256*area < 256^3`) and `SLOW_DIV` (`sum/area`) are the same truncating division, so one division is used for both.

## Formats

`formats()` returns the native `pix_fmts` in declared order (57 formats: planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included). Frames run in the eight-bit layouts with frame storage: yuv420p, yuv422p, yuv444p, gray, yuva420p and gbrp, plus the legacy yuvj420p/yuvj422p/yuvj444p sources of linear chains. nv12/nv21 convert to yuv420p and rgb24/bgr24 to gbrp, as natively. Packed RGB with alpha (rgba, bgra, argb, abgr) negotiates `gbrap` natively, which has no frame storage here: it is refused at plan time with `Video filter avgblur input negotiates gbrap, which is not implemented`, on every path and before any output is opened.

`frame()` returns owned, tight planes. It checks `maxFrameBytes` for the output and for the resident input storage, rejects malformed strides, plane counts, settings and time bases, checks `AbortSignal` per row, preserves the bigint PTS and metadata and never mutates its input.

## Paths

All five paths are flagged: `linear`, `graph`, `stream`, `actor` and `timed`. `avgblur` is a stateless `frame` operator.

## Determinism

Integer sums (at most 255 x 2049 x 2049, inside int32) and truncating integer division. No floating point, no platform or thread dependency; native calls the kernel unthreaded (`s->filter[slow](ctx, &td, 0, 0)`), and the threads test confirms default threads and `-filter_threads 1` agree. Conversions in chains run with `-cpuflags 0` natively and scalar arithmetic here. No case is platform gated.

## Evidence

Every comparison runs the sandbox's `.build/reference/ffmpeg` at test time and asserts `.build/reference/build-metadata.json` names commit 946fcce0 and `--disable-x86asm`. Sandbox build: sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v24.22.3, linux x86_64. Inputs are generated per test: LCG noise, a ramp with sparse near-saturated peaks, a saturated checkerboard and constant planes.

| Test (tests/differential/video-avgblur.test.ts) | Native comparisons |
|---|---|
| `matches native avgblur bytes across formats sizes radii planes and patterns` | 810 rawvideo runs: 6 formats x 9 sizes (1x1, 2x2, 1x3, 2x3, 5x3, 7x5, 8x6, 17x9, 40x2) x 15 option sets (sizeX 1, 2, 5, 64, 1024; sizeY different from sizeX; planes 0, 1, 2, 5, 10, 14), 4 frames each |
| `matches native avgblur with default filter threads and with -filter_threads 1` | 72 runs: 6 formats x 2 sizes x 3 option sets x {default threads, `-filter_threads 1`} |
| `matches native linear avgblur chains with negotiated conversion and scalar arithmetic` | 270 `compileVideoFilterChain` runs: 9 sources x 2 sizes x 3 targets x 5 chains |
| `matches native avgblur CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes` | 288 `-vf` and 48 two-output `-filter_complex` CLI runs, rawvideo and framecrc, with and without `-ss`/`-t` |
| `matches native replayed avgblur branches and joins frame by frame` | 20 `createReplayVideoExecution` runs |
| `matches native avgblur framecrc and rawvideo through the timed executor and activation actors` | 432 timed-backend runs: 144 native runs (6 formats x 1x1/2x3/5x3 x 4 graphs x framecrc/rawvideo) x {`pull`, `activation`, `producer`} |
| `refuses avgblur enable= timelines on every CLI path before opening outputs while native accepts them` | 10 refusals (media `-vf`/`-filter_complex`, timed pull/activation/producer) with no output opened, plus 2 native runs showing native accepts them |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | `avgblur=sizeX=2:planes=5:sizeY=3` from 17 sources: 13 byte-exact on the five paths (yuvj on linear), argb/rgba/abgr/bgra refused naming `gbrap` on the five paths and four CLI backends (89 checks) |

Unit tests (`tests/unit/video-avgblur.test.ts`, 5 tests): parsing, ranges and refusals; radius resolution and clipping; exact sums on padded, unmutated input; per-plane selection; budgets, malformed strides, plane counts, settings and time bases; AbortSignal; planner behaviour, gbrap refusals, `enable=` and runtime-command refusals. `tests/unit/video-operator-registry.test.ts` runs the three descriptor examples on all five paths.

## Proposed test contracts

| id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| filter.avgblur.kernel | tests/differential/video-avgblur.test.ts | matches native avgblur bytes across formats sizes radii planes and patterns | kernel | all |
| filter.avgblur.threads | tests/differential/video-avgblur.test.ts | matches native avgblur with default filter threads and with -filter_threads 1 | kernel, threads | all |
| filter.avgblur.linear | tests/differential/video-avgblur.test.ts | matches native linear avgblur chains with negotiated conversion and scalar arithmetic | linear | all |
| filter.avgblur.cli | tests/differential/video-avgblur.test.ts | matches native avgblur CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes | linear, graph | all |
| filter.avgblur.stream | tests/differential/video-avgblur.test.ts | matches native replayed avgblur branches and joins frame by frame | stream | all |
| filter.avgblur.timed | tests/differential/video-avgblur.test.ts | matches native avgblur framecrc and rawvideo through the timed executor and activation actors | actor, timed | all |
| filter.avgblur.refusals | tests/differential/video-avgblur.test.ts | refuses avgblur enable= timelines on every CLI path before opening outputs while native accepts them | refusals | all |
| filter.avgblur.negotiation | tests/differential/video-avgblur.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | negotiation, every path | all |

## Unsupported

- Native high-bit-depth formats and yuva422p/yuva444p/yuv440p/yuv411p/yuv410p/gbrap/yuvj440p/yuvj411p have no frame storage here; a negotiation that picks one is refused by name. Packed RGB with alpha sources negotiate `gbrap` and are refused before output.
- `enable=` timelines and the runtime `sizeX`/`planes`/`sizeY` commands.
- Native `config_input` overwrites the radii with their clipped values, so a link reconfigured to a larger size keeps the earlier clip. This module recomputes the clip from each frame's size; mid-stream size changes are not covered by any test.
