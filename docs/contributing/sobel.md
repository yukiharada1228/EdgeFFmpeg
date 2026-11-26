# sobel, prewitt, scharr and roberts video filters

`sobel`, `prewitt`, `scharr` and `roberts` follow pinned `libavfilter/vf_convolution.c`
and `libavfilter/convolution.h` (`filter_sobel`, `filter_prewitt`, `filter_scharr`,
`filter_roberts`, `setup_3x3`, `filter_slice`, `param_init` and the shared `common`
option class). All four descriptors share one kernel, `gradientVideoFrame` in
`packages/avfilter/src/video-sobel.ts`. Each descriptor
(`packages/avfilter/src/video-ops/{sobel,prewitt,scharr,roberts}.ts`) is registered with
one import line and one array line in `video-ops/registry.ts`.

For each sample of a plane selected by `planes`, the kernel reads the 3x3 neighbourhood
`c0..c8` (row-major, `c4` the sample itself). `setup_3x3` mirrors coordinates outside the
plane with `avpriv_mirror(v, n - 1)`, so row or column `-1` reads index 1 and index `n`
reads `n - 2`. A plane one sample wide or high reads that sample itself. The integer sums are:

| Operator | `suma` | `sumb` |
|---|---|---|
| sobel | `-c0 - 2c1 - c2 + c6 + 2c7 + c8` | `-c0 + c2 - 2c3 + 2c5 - c6 + c8` |
| prewitt | `-c0 - c1 - c2 + c6 + c7 + c8` | `-c0 + c2 - c3 + c5 - c6 + c8` |
| scharr | `(-47c0 - 162c1 - 47c2 + 47c6 + 162c7 + 47c8) / 256` | `(-47c0 + 47c2 - 162c3 + 162c5 - 47c6 + 47c8) / 256` |
| roberts | `c0 - c1` | `c4 - c3` |

Native converts the integer sums to `float` (scharr then divides by `256.f`). The output is
`av_clip_uint8((int)(sqrtf(suma*suma + sumb*sumb) * scale + delta))`. Here every float
operation is rounded with `Math.fround`: the two squares, their sum, `sqrtf`, the product
with `scale` and the sum with `delta`. Nothing is fused. The int conversion truncates toward
zero and the result is clipped to 0..255. roberts uses only the 2x2 window `c0, c1, c3, c4`
from the same mirrored 3x3 setup. Planes outside the mask are copied unchanged
(`av_image_copy_plane`).

`gradientVideoFrame` returns owned, tight, positive-stride planes and keeps the bigint PTS
and metadata. It checks `maxFrameBytes`, the input plane storage, strides, the plane count,
the time base, the step settings and the `AbortSignal` (per row, and every 16384 samples
within a row). It never mutates its input.

## Syntax

`<name>[=planes[:scale[:delta]]]`, or the named keys `planes`, `scale` and `delta`. Repeated
keys keep the last value.

- `planes`: `AV_OPT_TYPE_INT`, 0..15, default 15. Bit `i` selects plane `i` in storage
  order (gbrp: G, B, R; yuva420p: Y, U, V, A). It is parsed with the shared scoped
  integer-option helper: expressions, the `default`/`min`/`max` constants and `llrint`
  half-to-even rounding.
- `scale`: `AV_OPT_TYPE_FLOAT`, 0..65535, default 1. `delta`: `AV_OPT_TYPE_FLOAT`,
  -65535..65535, default 0. Both follow `set_string_number`: an expression with the
  `default`, `max`, `min`, `none` and `all` constants, range-checked as a double and then
  stored as `float` (`Math.fround`).

Refused before any output is opened:

- An out-of-range value (native `out of range`), an unknown key such as the convolution
  class's `0m` or `rdiv` (native `Option not found`, here `Unsupported <name> option`), and
  a fourth positional value (native `No option name`).
- A `NaN` scale or delta (for example `scale=0/0`). Native's range check lets NaN through.
  It is refused here rather than mirrored.
- `enable=`. Native supports the generic timeline, which is not implemented here
  (`<Name> timeline expressions are not implemented`). Other generic options (`threads`, and
  so on) are refused too.
- Runtime commands. Native `process_command` re-runs `param_init`. The descriptors set
  neither `timeline` nor `geometryCommands`, so commands are refused.

## Formats and paths

`formats()` returns the native `vf_convolution.c` `pix_fmts` list in declared order: 57
formats covering planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included. The
shared negotiators therefore pick what native picks. Frames run in the eight-bit layouts
with frame storage (`yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p` and `gbrp`), and in
the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. Negotiation converts
nv12/nv21 to yuv420p and rgb24/bgr24 to gbrp, as native does. Packed RGB with alpha (argb,
rgba, abgr, bgra) negotiates `gbrap`, which has no frame storage here. It is refused by name
(`Video filter <name> input negotiates gbrap, which is not implemented`) on every path,
before output. The size never changes, and no size is refused: the mirror borders never
read outside the plane.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operators are
stateless, so the actor and timed executors call `frame` directly. Native slices rows across
threads (`FFMIN3(planeheight[1], planewidth[1], nb_threads)` jobs). Each output row depends
only on the input, so the threaded and single-threaded results are equal. The threads test
checks this.

## Determinism and arithmetic profile

- The kernel emulates the unfused x86-64 float baseline. The reference is built with
  `--disable-x86asm`, so `ff_sobel_init_x86` is not used. GCC on x86-64 without `-mfma`
  emits no fused multiply-adds. macOS arm64 contracts `suma*suma + sumb*sumb` and
  `sqrt*scale + delta` into fused multiply-adds.
- **Portable cases.** For sobel, prewitt and roberts the integer sums stay below 2^12 in
  magnitude. The sum of squares is then exact in float, fused or not. A power-of-two
  `scale` (1 or 4) makes `sqrt*scale` exact, so a fused `sqrt*scale + delta` rounds the same
  as the unfused pair, for any delta. These cases are compared on every platform.
- **Linux-x64 cases.** Scharr's `/256` squares round in float, and so does any other scale
  (0.3 and 0.7 here). These cases run only on linux-x64, in tests with constant titles that
  are skipped elsewhere.
- **Evidence for the gate.** A step-5 horizontal ramp puts sobel, prewitt and scharr at
  magnitudes 40, 30 and 10, where `scale=0.7` lands within one float ulp of an integer. Two
  mutations of the kernel were tried in the sandbox. Double arithmetic everywhere, and a
  fused emulation (`fround(sqrt*scale + delta)` computed exactly), each failed only the
  linux-x64 API test. The portable tests still passed under both mutations.
- No macOS arm64 difference has been measured: no macOS run was made from this branch.
  The gate is a precaution backed by the fused-emulation mutation.
- High-bit-depth kernels (`filter16_*`) are unreachable: high-depth picks have no frame
  storage here and are refused.

## Evidence

`tests/differential/video-sobel.test.ts` runs `.build/reference/ffmpeg` (`-cpuflags 0`)
at test time. It first reads `.build/reference/build-metadata.json` and asserts commit
`946fcce0` and `--disable-x86asm`. It commits no native goldens.

The inputs are 6 formats (gray, yuv420p, yuv422p, yuv444p, yuva420p, gbrp) and 6 sizes
(1x1, 2x2, 5x3, 7x5, 8x6, 17x9). There are two 3-frame patterns: LCG noise, and a
structured input (step-5 ramp, hard edges, constant planes).

The portable descriptions are 24: for each of sobel, prewitt and roberts, the defaults,
`scale=4`, `delta=-20`, `delta=30`, `planes=1`, `planes=6:delta=30`,
`planes=9:scale=4:delta=-20` and the shorthand `15:4:30`.

The linux-x64 descriptions are 25: the same 8 for scharr; for each of the four operators,
`scale=0.3`, `scale=0.3:delta=-20` and `planes=5:scale=0.3:delta=30`; and the rounding
boundary set `sobel=scale=0.7`, `sobel=scale=0.7:delta=-27`,
`prewitt=scale=0.7:delta=-20`, `scharr=scale=0.7` and `scharr=scale=0.7:delta=-6`.

| Test | Platforms | Comparisons |
|---|---|---|
| `checks the native reference build at test time` | all | commit and `--disable-x86asm` |
| `matches native sobel, prewitt and roberts through the linear, frame graph and replay APIs with integer-exact scales` | all | 1728 native outputs (72 inputs x 24 descriptions), each matched by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution` (5184 matches) |
| `matches native scharr and the inexact 0.3 scales of every operator through the linear, frame graph and replay APIs (linux-x64)` | linux-x64 | 1800 native outputs (72 x 25), 5400 matches |
| `matches native sobel, prewitt and roberts rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path` | all | 1080 CLI runs: 18 inputs (6 formats at 1x1, 5x3 and 17x9) x 3 descriptions x rawvideo/framecrc x {none, `-ss 0.04 -t 0.05`} x 5 paths (`-vf`; single-input and multi-input `-filter_complex`; timed `producer` and `pull`) |
| `matches native scharr and inexact scale rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path (linux-x64)` | linux-x64 | 720 CLI runs (2 descriptions) |
| `agrees with native under default slice threads and -filter_threads 1, and matches it for integer-exact scales` | all | 294 native default-thread vs `-filter_threads 1` pairs (3 formats x 17x9 and 64x48 x 49 descriptions), all equal. Native-to-native, so platform-neutral. Of these, 144 portable outputs are also matched by the linear chain. |
| `fails like native for out-of-range and unknown options, and refuses the timeline, before opening outputs on every path` | all | 35 failures on both sides (7 option errors x 5 paths, native diagnostic checked) and 10 timeline refusals, with no output opened |
| `negotiates every accepted source as native does for sobel, prewitt and roberts and refuses the packed-alpha gbrap picks before output on every path` | all | 3 x 89 checks over 17 sources: 13 byte-exact picks, 4 refused naming `gbrap` |
| `negotiates every accepted source as native does for scharr and refuses the packed-alpha gbrap picks before output on every path (linux-x64)` | linux-x64 | 89 checks |

All 9 tests passed in the sandbox (linux x86_64, 4 vCPUs, about 80 s with `--maxWorkers=1`).
The reference there was an unpinned build of commit `946fcce0`:

- ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`
- `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`

`tests/unit/video-sobel.test.ts` has 6 tests. They cover parsing, refusals, the format
list and paths, hand-computed ramps and edges with mirrored borders, truncation and
clipping, plane masks, budgets, malformed strides, the plane count, the time base, invalid
settings, the `AbortSignal`, an unmutated input with owned output planes, and planning on
every path. `tests/unit/video-operator-registry.test.ts` runs the descriptor examples on
all five paths.

## Proposed contracts

| id | file | title | scope | platforms |
|---|---|---|---|---|
| filter.sobel/prewitt/roberts api | `tests/differential/video-sobel.test.ts` | `matches native sobel, prewitt and roberts through the linear, frame graph and replay APIs with integer-exact scales` | kernel, linear/graph/stream APIs | all |
| filter.scharr + float scales api | same | `matches native scharr and the inexact 0.3 scales of every operator through the linear, frame graph and replay APIs (linux-x64)` | float-rounded kernel | linux-x64 |
| filter.sobel/prewitt/roberts cli | same | `matches native sobel, prewitt and roberts rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path` | five CLI paths | all |
| filter.scharr + float scales cli | same | `matches native scharr and inexact scale rawvideo and framecrc bytes with and without -ss/-t on every flagged CLI path (linux-x64)` | five CLI paths | linux-x64 |
| threads | same | `agrees with native under default slice threads and -filter_threads 1, and matches it for integer-exact scales` | slice threading | all |
| refusals | same | `fails like native for out-of-range and unknown options, and refuses the timeline, before opening outputs on every path` | option errors | all |
| negotiation | same | `negotiates every accepted source as native does for sobel, prewitt and roberts and refuses the packed-alpha gbrap picks before output on every path` | per-source negotiation | all |
| negotiation scharr | same | `negotiates every accepted source as native does for scharr and refuses the packed-alpha gbrap picks before output on every path (linux-x64)` | per-source negotiation | linux-x64 |
| unit | `tests/unit/video-sobel.test.ts` | all 6 tests | parse, kernel, refusals | all |

## Unsupported

- The `enable=` timeline, runtime commands and generic filter options.
- NaN `scale` or `delta`.
- High-bit-depth formats and the native formats without frame storage here (yuva444p,
  yuva422p, yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, gbrap). A negotiation that picks
  one, such as packed RGB with alpha (`gbrap`), is refused by name before output.
- `kirsch` and `convolution` from the same file are not part of this item.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged, so the
  `mp4-h264.ts` aspect derivation is unaffected.
