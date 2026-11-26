# colorkey and colorhold video filters

`colorkey` makes the pixels near a key colour transparent. `colorhold` turns every pixel except those near the key colour toward gray. Both are adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorkey.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`) and share one kernel, `packages/avfilter/src/video-colorkey.ts`. The descriptors are `packages/avfilter/src/video-ops/colorkey.ts` and `colorhold.ts`. Provenance is in `packages/avfilter/NOTICE-COLORKEY`.

## Syntax

`colorkey[=color:similarity:blend]` and `colorhold[=color:similarity:blend]`, or the named options in any order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `color` | `AV_OPT_TYPE_COLOR` | any `av_parse_color` colour; the alpha is parsed and ignored | `black` |
| `similarity` | `AV_OPT_TYPE_FLOAT` | 0.00001..1 | 0.01 |
| `blend` | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |

Colours go through the shared `parseColor` from `@edge-ffmpeg/avutil` (PREP-COLOR), so names, `#RRGGBB`, `0xRRGGBB[AA]` and `@alpha` suffixes behave as natively. A colour native rejects fails with native's message, for example `Cannot find color 'nocolor'` or `Invalid 0xRRGGBB[AA] color string: '12345'`. Colours native accepts with a random or platform-undefined value (`random`, NaN or platform-dependent alphas) are refused with `Unsupported <name> color: ...`.

`similarity` and `blend` accept decimal numbers only. The double is range-checked first and then stored as a float (`Math.fround`), as `write_number` does. Out-of-range values fail with native's message, `Value 2.000000 for parameter 'similarity' out of range [1e-05 - 1]`. Expressions, SI suffixes and the `default`/`min`/`max` constants are refused with `Only decimal <name> <option> values are implemented`.

## Arithmetic

All supported formats have depth 8, so `max` is 255, `scale` is `255.0 / 255` (exactly 1.0) and `depth` is 8.

- `do_colorkey_pixel`: `d = r*scale - key` in double for each channel, `diff = sqrt((dr*dr + dg*dg + db*db) / (255*255*3))`. With `iblend = 1.f / blend` computed in float (blend 0 gives infinity): when `iblend < 10000`, the result is `trunc(clip((diff - similarity) * iblend, 0, 1) * 255)`; otherwise it is `diff > similarity ? 255 : 0`. `similarity` is the stored float promoted to double.
- `colorkey` writes that value into the alpha byte and leaves R, G and B unchanged.
- `colorhold` keeps alpha. When `t > 0`, each of R, G and B becomes `(a*t + c*(255 - t) + 127) >> 8` with `a = trunc((r + g + b) / 3)` in int. A pure white pixel held completely becomes 254, as natively.

Byte offsets follow `ff_fill_rgba_map`: rgba 0,1,2,3, bgra 2,1,0,3, argb 1,2,3,0 and abgr 3,2,1,0 for R, G, B and A. Native filters the frame in place (`AVFILTERPAD_FLAG_NEEDS_WRITABLE`). Here the output is a new owned, tight plane, and the input frame is never mutated.

## Formats

`formats()` returns the shared native `pixel_fmts` list in declared order: argb, rgba, abgr, bgra, rgba64le, bgra64le. Frames run here in the four packed 8-bit orders. Every other source gets native's automatic conversion. Native picks argb from every non-packed source in the per-source negotiation test (yuv420p, rgb24, bgr24, yuv422p, yuv444p, gray, nv12, nv21, yuva420p, gbrp and the legacy yuvj sources). A pick of rgba64 or bgra64 has no frame storage here and would be refused by name by the shared negotiators. None of the 17 accepted sources produces such a pick.

## Refused forms

- `enable=`: `<name> timeline expressions are not implemented`. Native supports the generic timeline.
- Runtime commands (`color`, `similarity`, `blend`, `enable`): the descriptors set neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them (`ff_filter_process_command`).
- Any other option, for example `threads`: `Unsupported <name> option`.
- Frames in a format other than the four packed orders, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with explicit errors. `AbortSignal` is checked before the work starts and on every row.
- **Exit status.** Native exits with `256 - EINVAL` (234 on Linux) for an invalid colour and `256 - ERANGE` (222) for an out-of-range float. EdgeFFmpeg refuses the same inputs before any output is opened, but every filter parse failure on the CLI exits with 1, because the frontends wrap filter errors without an exit code. Matching native's status needs a shared change to that wrapping (see the report).

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all through the stateless `frame` function. The registry examples run on the 8x8 gray source (native picks argb, which has storage) and with explicit `format=` stages.

## Determinism

At depth 8, `r*scale - c` with `scale == 1.0` and the squared sum are exact integers in double, so fused and unfused evaluation give the same value. The division and `sqrt` are correctly rounded IEEE operations. No macOS difference has been measured. The soft-blend cases (`blend > 0`, where `(diff - similarity) * iblend` is truncated) are still gated to linux-x64 as a precaution, as the specification's determinism notes require. The float reciprocal `1.f / blend` is reproduced with `Math.fround`. The test includes 10 crafted distances from black where the float reciprocal truncates one level above the double reciprocal, and native agrees with the float form. The hard-key cases (`blend = 0` or tiny blends, which reach the `iblend >= 10000` branch) run on every platform.

The Linux reference is built with `--disable-x86asm`. This filter has no assembly. Native slices are independent row ranges, so the output does not depend on the thread count.

## Evidence

`tests/differential/video-colorkey.test.ts` runs `.build/reference/ffmpeg` at test time. It asserts that `build-metadata.json` names commit `946fcce0` and `--disable-x86asm`, and it has no committed goldens. Native runs with `-cpuflags 0`, and EdgeFFmpeg uses scalar arithmetic. Inputs mix LCG noise, ramps, the exact key colour, the key colour nudged by up to 4 levels, a 0/255 checkerboard and constant mid-gray, with noise in the alpha byte. The file was run on a sandbox build of the reference: linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. It took about 10 s with `--maxWorkers=1`.

| Test title | Path | Comparisons |
|---|---|---|
| `matches native colorkey and colorhold hard keys across packed RGBA orders, sizes and patterns` | linear (`compileVideoFilterChain`) | 4 packed orders x sizes 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 x 38 descriptions (both filters, keys black, green and 0x336699@0.5, similarity 0.00001, 0.01, 0.1, 0.3, 0.5 and 1, plus the defaults): 912 three-frame rawvideo matches with timestamps |
| `matches native colorkey and colorhold soft blends across packed RGBA orders and every path on linux-x64` (linux-x64 only) | linear, CLI linear/actor/timed, graph, stream | 864 kernel cases (4 orders x 1x1, 5x3, 17x9 x 72: both filters, 3 keys x similarity 0.01, 0.1, 0.5 x blend 0.00005, 0.2, 0.5, 1), 72 CLI outputs, 8 graph cases (16 files), 2 replay streams and 48 float-reciprocal boundary cases: 994 |
| `matches native colorkey and colorhold CLI rawvideo and framecrc on the linear, actor and timed paths, including implicit conversions` | linear `-vf` (media backend), actor (`producer`), timed (`pull`) | 7 sources (the 4 packed orders, plus yuv420p, rgb24 and gray converted to argb) x 4 chains x {rawvideo, framecrc} x {untimed, `-ss 0.04` with `-t 0.05`} x 3 paths: 336 |
| `matches native colorkey and colorhold filter_complex branches on the graph path in rawvideo and framecrc` | graph `-filter_complex` | 4 sources (rgba, argb, yuva420p, gbrp) x 2 graphs x 2 muxers x {untimed, `-ss 0.04 -frames:v 1`}, with two outputs each: 32 cases, 64 files |
| `matches native colorkey and colorhold on the stream path through replay execution and the multi-input CLI` | stream | 6 `createReplayVideoExecution` cases (rgba, abgr to abgr, yuv420p to bgra, with split/hstack branches) and 2 multi-input CLI vstack joins (rawvideo and framecrc): 8 |
| `fails like native for invalid colours and out-of-range floats, and refuses enable= and random colours, before opening any output on every path` | linear, graph, stream, actor, timed | 6 native refusals (status `256 - errno`, the native message, no output file) refused here with the same message and no output opened, plus the `enable=` and `random` refusals: 8 |
| `negotiates every accepted source as native does for colorkey and colorhold and runs byte-exact on every path` | linear, graph, stream, actor, timed | `colorkey` and `colorhold=green:0.3` from the 17 negotiation sources, with native's pick read from showinfo: 14 sources on 5 paths plus 3 yuvj sources on linear chains, 73 checks each, 146 in total |

Total: 2434 native comparisons on linux-x64, and 1440 on platforms where the soft-blend test is skipped.

Mutations each caught by this file: `+128` instead of `+127` in the hold rounding (6 tests failed), rounding instead of truncating the soft key (1), `>=` for the hard key (1), a double instead of a float `1.f/blend` (1, through the boundary cases), and the rgba map used for bgra (3).

`tests/unit/video-colorkey.test.ts` (4 tests) covers parsing, defaults, shorthand, ranges and messages, colour refusals, `enable=` and unknown options, the format list and descriptor flags, worked kernel values for both filters in every byte order, budgets, malformed strides and plane counts, invalid settings, `AbortSignal`, an unmutated padded input, linear/graph/actor parse refusals, the argb pick for non-packed sources, and refused runtime commands.

## Proposed test contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| `filter.colorkey.hard` | `tests/differential/video-colorkey.test.ts` | `matches native colorkey and colorhold hard keys across packed RGBA orders, sizes and patterns` | kernel bytes on the linear path, blend 0, every packed order and size | all |
| `filter.colorkey.soft` | `tests/differential/video-colorkey.test.ts` | `matches native colorkey and colorhold soft blends across packed RGBA orders and every path on linux-x64` | blend > 0 on the kernel, CLI, graph and stream paths, plus the float-reciprocal boundaries | linux-x64 |
| `filter.colorkey.cli` | `tests/differential/video-colorkey.test.ts` | `matches native colorkey and colorhold CLI rawvideo and framecrc on the linear, actor and timed paths, including implicit conversions` | `-vf` rawvideo and framecrc with and without `-ss`/`-t` on the media and timed backends | all |
| `filter.colorkey.graph` | `tests/differential/video-colorkey.test.ts` | `matches native colorkey and colorhold filter_complex branches on the graph path in rawvideo and framecrc` | `-filter_complex` with two outputs | all |
| `filter.colorkey.stream` | `tests/differential/video-colorkey.test.ts` | `matches native colorkey and colorhold on the stream path through replay execution and the multi-input CLI` | replay streams and the multi-input CLI | all |
| `filter.colorkey.reject` | `tests/differential/video-colorkey.test.ts` | `fails like native for invalid colours and out-of-range floats, and refuses enable= and random colours, before opening any output on every path` | option refusals before output, with native's message | all |
| `filter.colorkey.negotiation` | `tests/differential/video-colorkey.test.ts` | `negotiates every accepted source as native does for colorkey and colorhold and runs byte-exact on every path` | native picks from 17 sources | all |

## Unsupported scope

- rgba64 and bgra64 (16-bit) frames: no storage here. No accepted source negotiates them.
- Expression-valued, suffixed or constant `similarity` and `blend`.
- `random` and platform-undefined colours.
- `enable=` timelines and runtime commands.
- Native's EINVAL and ERANGE exit statuses (EdgeFFmpeg exits with 1).
- H.264/MP4 framecrc output was not compared.
