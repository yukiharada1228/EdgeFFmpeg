# colorcorrect video filter

`colorcorrect` adjusts white balance separately for shadows and highlights: it rewrites the U and V planes from each chroma sample and the co-sited luma sample, and copies Y and alpha. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorcorrect.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-COLORCORRECT`; the descriptor is `packages/avfilter/src/video-ops/colorcorrect.ts`.

## Syntax

`colorcorrect[=rl:bl:rh:bh:saturation:analyze]`, or the named options in any order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `rl` | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `bl` | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `rh` | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `bh` | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `saturation` | `AV_OPT_TYPE_FLOAT` | -3..3 | 1 |
| `analyze` | `AV_OPT_TYPE_INT` | 0..3 (`manual`, `average`, `minmax`, `median`) | `manual` |

Float values are constant decimals (`0.5`, `.25`, `1.`, `5e-1`, an optional sign) or the constants `default`, `max`, `min`, `none` and `all` (-1) that `set_string_number` offers. The double is range checked, then stored rounded to single precision (`Math.fround`), as `write_number` stores a float. `analyze` takes its unit constants, the same generic constants (`max` is 3, `all` is -1 and out of range), or a decimal range checked as a double and rounded with `llrint` (ties to even: `2.5` is `minmax`). Out-of-range values fail with `Invalid colorcorrect <option>: value outside <min>..<max>` while parsing, before any output is opened, as native's range check fails.

## Semantics

For depth 8, `max = 255` and `imax = 1.f / 255`. Per chroma sample at (x, y), with `Y` the luma sample at (x * chroma_w, y * chroma_h):

```
y = Y * imax;  u = U * imax - .5f;  v = V * imax - .5f
nu = saturation * (u + y * (bh - bl) + bl);  nv = saturation * (v + y * (rh - rl) + rl)
U' = av_clip_uint8((int)((nu + .5f) * max));  V' = av_clip_uint8((int)((nv + .5f) * max))
```

Every operation is one IEEE-754 single-precision operation, in C evaluation order, rounded with `Math.fround`; the float-to-int conversion truncates toward zero. The defaults are not an identity: `(c * imax - .5f + .5f) * 255` truncates to `c - 1` for c = 1..47.

With `analyze`, `filter_frame` recomputes the spots from every frame before the pass, replacing the manual `rl`..`bh`:

- `median` (`median_8`, always one slice): per chroma plane, the first value whose running histogram count reaches `w * h / 2` (integer division, so 0 for a one-sample plane). `bl = bh = -(imax * median_u - .5f)`, `rl = rh = -(imax * median_v - .5f)`.
- `minmax` (`minmax_slice8`): `bl = -(imax * min_u - .5f)`, `bh = -(imax * max_u - .5f)`, and the same from V for `rl`, `rh`.

Native rewrites the frame in place (`AVFILTERPAD_FLAG_NEEDS_WRITABLE`); here the result is written to owned tight planes and the input frame is not changed.

## Formats

`formats()` returns native `pixel_fmts` in declared order (41 formats, native-endian names). Only yuv420p, yuv422p, yuv444p and yuva420p have frame storage here; the shared negotiators refuse every other pick at plan time with `Video filter colorcorrect input negotiates <format>, which is not implemented`, on every path and before any output is opened.

Native picks, measured by the per-source negotiation test (`-cpuflags 0`):

| Source | Native pick | Here |
|---|---|---|
| yuv420p, nv12, nv21 | yuv420p | byte-exact |
| yuv422p | yuv422p | byte-exact |
| yuv444p, rgb24, bgr24, gbrp | yuv444p | byte-exact |
| yuva420p | yuva420p | byte-exact |
| yuvj420p, yuvj422p, yuvj444p (linear chains) | the same yuvj format | byte-exact |
| gray | yuvj444p | refused by name |
| argb, rgba, abgr, bgra | yuva444p | refused by name |

The registry examples run from an 8x8 gray source, which would pick yuvj444p, so each example starts with `format=yuv444p`, `format=yuv420p`, `format=yuva420p` or `format=yuv422p`. The filter is planar YUV only, so there are no packed component orders to cover.

## Refused forms

- `analyze=average` (and `analyze=1`, `1.4`, `0.6`): `Colorcorrect analyze=average is not implemented: its result depends on the native slice count`. `average_slice8` divides per-slice sums in float and `filter_frame` averages the slices, so native output changes with the thread count (measured: default threads and `-filter_threads 1` differ on a 32x16 yuv420p frame).
- `analyze=minmax` when the chroma plane has more than one row: `Colorcorrect analyze=minmax is implemented only for one-row chroma planes: ...`. `filter_frame` averages per-slice extremes over `FFMIN(chroma rows, threads)` slices, so native output depends on the host's thread count (measured: default threads and `-filter_threads 1` differ on 32x16 yuv420p). With one chroma row native always runs one slice. The refusal is in `geometry()`, so every planner raises it before output, and `frame()` repeats it.
- `enable=`: `Colorcorrect timeline expressions are not implemented`. Native supports the generic timeline.
- Runtime commands (`rl`, `bl`, `rh`, `bh`, `saturation`, `analyze`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them.
- Expressions and other non-decimal values (`1/3`, `0x1`): `Only constant decimal colorcorrect <option> values are implemented` (or `Only constant colorcorrect analyze values are implemented`). Native evaluates them.
- Any other option, such as `threads`: `Unsupported colorcorrect option`.
- Frames in another format, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with explicit errors. `AbortSignal` is checked before work and on every row.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function plus the `geometry` refusal.

## Determinism

Single-precision float per pixel with no libm transcendentals. The x86-64 baseline (SSE, `FLT_EVAL_METHOD` 0, no contraction) rounds every operation; `Math.fround` after every operation reproduces it. macOS arm64 contracts `U * imax - .5f` and `u + y * bd` into fused multiply-adds: the unit test shows that a fused `u` alone changes 15 of the 256 default outputs, so even the defaults are float-sensitive. Every native byte comparison is therefore gated to linux-x64 (`it.skipIf`, constant titles); the build-metadata check and the refusal test run everywhere. No macOS difference was measured in the sandbox; the gate follows the arithmetic profile. The manual pass and `median` are independent of the slice count: the frame test checks that native default threads and `-filter_threads 1` give the same bytes for every frame case.

## Evidence

`tests/differential/video-colorcorrect.test.ts` runs `.build/reference/ffmpeg` at test time, after asserting from `.build/reference/build-metadata.json` that it is commit `946fcce0` built with `--disable-x86asm`. It ran on linux x64 in the wave 2 sandbox, with ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. This is an unpinned sandbox build, not the pinned linux-x64 reference. Inputs are LCG noise, ramps with 0/255 edges, constant planes with a stripe, and ramp frames covering every chroma value over every luma value.

| Test title | Path | Platforms | Comparisons |
|---|---|---|---|
| `runs against the reference build of commit 946fcce0 configured with --disable-x86asm` | – | all | build metadata check |
| `matches native colorcorrect frames for every format, size and option case, with default and single filter threads` | kernel | linux-x64 | 4 formats x 6 sizes x 20 option cases (480), one-row minmax (18), every-value ramps (16): 514 byte matches of 3-frame (ramps 1-frame) outputs, each also checking the input unmutated, plus 514 native default-thread vs `-filter_threads 1` agreements |
| `matches native colorcorrect CLI rawvideo and framecrc through -vf and -filter_complex` | linear, graph (media CLI) | linux-x64 | 6 source/option pairs x {`-vf`, `-filter_complex`} x 3 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`} (144), plus one-row minmax and nv12 conversion (6): 150 |
| `matches native replayed colorcorrect branches and joins frame by frame` | stream | linux-x64 | 6 pairs x 3 graphs (single, split + hstack, split + nullsink): 18 |
| `matches native colorcorrect framecrc and rawvideo through the actor and timed schedulers` | actor (`activation`, `producer`), timed (`pull`) | linux-x64 | 6 pairs x 2 chains x 2 muxers x {3, 2 frames} x 3 schedulers: 144 |
| `refuses colorcorrect average, multi-slice minmax, timelines and unimplemented values before opening CLI outputs` | linear, graph, timed | all | 7 forms native accepts x {`-vf`, `-filter_complex`} x {media, timed pull}: 28 refusals with no output opened; 6 out-of-range values that native also rejects: 34 |
| `negotiates every accepted colorcorrect source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed, CLI | linux-x64 | 2 filters x 17 sources with native's pick from showinfo: 12 byte-exact on the five paths (yuvj on linear only), 5 refused by name on the five paths and four CLI backends: 93 checks each, 186 |
| `plans colorcorrect through compileVideoFilterChain with negotiated conversions as native does` | linear | linux-x64 | 4 sources (yuv420p, yuva420p, nv12, yuv444p): 4 |

Mutations caught: a fused `u` (6 tests failed), rounding instead of truncating the store (6), `ceil` for `half_size` (1), and reassociating `(u + y * bd) + bl` (2).

`tests/unit/video-colorcorrect.test.ts` covers parsing, constants, float storage, ranges and messages, the default and typical arithmetic, subsampled luma siting, alpha and luma copies, median and minmax, the minmax refusal, unmutated padded input and owned output planes, refused formats, budgets, malformed strides and plane counts, invalid settings, `AbortSignal`, plan-time refusals on the linear, graph and timed planners, and refused runtime commands. It runs on every platform (pure TypeScript arithmetic).

## Proposed test contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| `filter.colorcorrect.frames` | `tests/differential/video-colorcorrect.test.ts` | `matches native colorcorrect frames for every format, size and option case, with default and single filter threads` | 4 formats, 6 sizes, every option at both ends, median, one-row minmax, every-value ramps, thread independence | linux-x64 |
| `filter.colorcorrect.cli` | `tests/differential/video-colorcorrect.test.ts` | `matches native colorcorrect CLI rawvideo and framecrc through -vf and -filter_complex` | `-vf` and `-filter_complex` rawvideo and framecrc, `-ss`/`-t` | linux-x64 |
| `filter.colorcorrect.stream` | `tests/differential/video-colorcorrect.test.ts` | `matches native replayed colorcorrect branches and joins frame by frame` | replay streams with split and hstack | linux-x64 |
| `filter.colorcorrect.timed` | `tests/differential/video-colorcorrect.test.ts` | `matches native colorcorrect framecrc and rawvideo through the actor and timed schedulers` | timed backend `pull`, `activation` and `producer` | linux-x64 |
| `filter.colorcorrect.reject` | `tests/differential/video-colorcorrect.test.ts` | `refuses colorcorrect average, multi-slice minmax, timelines and unimplemented values before opening CLI outputs` | scope refusals and out-of-range parity, no output opened | all |
| `filter.colorcorrect.negotiation` | `tests/differential/video-colorcorrect.test.ts` | `negotiates every accepted colorcorrect source as native does and refuses picks without storage before output on every path` | native picks from 17 sources | linux-x64 |
| `filter.colorcorrect.chain` | `tests/differential/video-colorcorrect.test.ts` | `plans colorcorrect through compileVideoFilterChain with negotiated conversions as native does` | linear plans with conversions | linux-x64 |

## Unsupported scope

- `analyze=average`, and `analyze=minmax` over more than one chroma row: native output depends on the thread count.
- Every format other than yuv420p, yuv422p, yuv444p and yuva420p (and the yuvj forms on linear chains): no frame storage here. Native picks yuvj444p from gray and yuva444p from packed RGBA.
- `enable=` timelines, runtime commands, option expressions.
