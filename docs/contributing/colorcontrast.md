# colorcontrast video filter

`colorcontrast` adjusts the red-cyan, green-magenta and blue-yellow contrast of RGB pixels, with optional lightness preservation. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorcontrast.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-COLORCONTRAST`; the descriptor is `packages/avfilter/src/video-ops/colorcontrast.ts`.

## Syntax

`colorcontrast[=rc:gm:by:rcw:gmw:byw:pl]`, or the same names as named options in any order. Later occurrences of an option win. The shorthand order is the AVOption order.

| Option | Meaning | Type | Range | Default |
|---|---|---|---|---|
| `rc` | red-cyan contrast | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `gm` | green-magenta contrast | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `by` | blue-yellow contrast | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `rcw` | red-cyan weight | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |
| `gmw` | green-magenta weight | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |
| `byw` | blue-yellow weight | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |
| `pl` | amount of lightness preserved | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |

Each value goes through `set_string_number`: an av_expr expression (decimals, arithmetic such as `1/3`, hex, SI suffixes) over the constants `default`, `max`, `min`, `none` and `all` (-1), evaluated with the linux-x64 numeric profile. `write_number` range-checks the double, and the option stores it as a float (`Math.fround`).

## Supported and refused forms

- **Supported:** every option value in range, in any order, shorthand or named. The defaults (all weights 0) are an identity: native's row loop runs only while `gmw + byw + rcw > FLT_EPSILON`, so any weight sum at most 2^-23 (for example `gmw=1e-7`) leaves the frame unchanged.
- **Out of range** (`rc=1.5`, `rcw=-0.5`, `rcw=all`, `pl=inf`): `Invalid colorcontrast <option>: value outside <low>..<high>`. Native fails too.
- **Unparsable values, including NaN results** (`rc=`, `rc=abc`, `rc=nan`, `rcw=0/0`): `Invalid colorcontrast <option>: …`. av_expr_parse_and_eval rejects NaN, so native fails too.
- **`enable=`:** `Colorcontrast timeline expressions are not implemented`. Native supports the generic timeline.
- **Runtime commands:** native's `process_command` (every option is `AV_OPT_FLAG_RUNTIME_PARAM`) is refused. The descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer every command with the unsupported code (-38 for `rc`…`pl`, the `enable` refusal for `enable`).
- **Any other option** (for example `threads`): `Unsupported colorcontrast option`.
- Frames in a format other than the seven below, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every row and every 4096 pixels.

Every option refusal happens while parsing, before negotiation, input reads or output opens, on every path.

## Formats

`formats()` is the native `pixel_fmts` list in declared order with native-endian names, 24 formats: `rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le rgb48le bgr48le rgba64le bgra64le`. Frames run in the seven members with frame storage here: `rgb24`, `bgr24`, `rgba`, `bgra`, `argb`, `abgr` and `gbrp`. Any negotiation that picks another member is refused by name by the shared negotiators. Native's picks were measured from all 17 negotiation sources, and every one has storage: yuva420p negotiates `argb`, gbrp stays `gbrp`, packed RGB stays as is, and every other YUV and gray source negotiates `rgb24`.

## Arithmetic

The per-frame constants are those of the slice functions: `gm = gm * 0.5f`, `by = by * 0.5f`, `rc = rc * 0.5f`, `sum = (gmw + byw) + rcw`, `scale = 1.f / sum`. Each pixel runs `PROCESS(255.f)` in single precision, every operation rounded to float with `Math.fround`, in the C evaluation order: channel means, differences, the nine `g0..r2` products and sums, the weighted mix `((x0 * gmw + x1 * byw) + x2 * rcw) * scale`, `av_clipf` to 0..255 (`FFMIN(FFMAX(a, 0), 255)`), the lightness ratio `(FFMAX3 + FFMIN3) / (FFMAX3' + FFMIN3' + FLT_EPSILON)`, and `lerpf(v0, v1, pl) = v0 + (v1 - v0) * pl`. `av_clip_uint8` takes an int, so each result is truncated toward zero before clipping. No libm function is involved.

- Packed formats use the `ff_fill_rgba_map` byte offsets (rgb24 0/1/2, bgr24 2/1/0, rgba 0/1/2, bgra 2/1/0, argb 1/2/3, abgr 3/2/1) and step `nb_components` (3 or 4). The alpha byte is never written, so it is copied.
- `gbrp` planes are G, B, R (`colorcontrast_slice8`).
- Every R, G and B byte is overwritten from its own pixel only, so writing in place (native) or into a copy (here) gives the same output.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry examples run from the 8x8 gray source, which native negotiates to `rgb24`; three of them add `format=gbrp`, `format=rgba` or `format=rgb24` to reach the other kernels.

## Determinism

The kernel is single-precision float with no libm transcendentals. The x86-64 Linux reference has no FMA (`--disable-x86asm`, baseline SSE2), so every product and sum rounds separately, which `Math.fround` after every operation reproduces exactly. On macOS arm64, clang contracts `a + b * c` into fused multiply-adds, so native output there can differ in the last bit and therefore in a truncated byte. Every case with an active weight sum is therefore gated to linux-x64 (`it.skipIf`, constant titles ending in `on linux-x64`, contracts declaring `"platforms": ["linux-x64"]`). The gate is a precaution: no macOS difference was measured in this sandbox, which had no macOS host. The identity cases (weight sum at most `FLT_EPSILON`), the refusals and the negotiation test (identity settings) do no float arithmetic on pixels and run everywhere. No test drops cases per platform. Slices are independent row ranges, and native with default threads, `-filter_threads 4` and `-filter_threads 1` agree.

Two mutations were checked against the differential file: computing in double precision (no `Math.fround`) and rounding instead of truncating in `av_clip_uint8` each fail all six linux-gated tests.

## Evidence

`tests/differential/video-colorcontrast.test.ts` runs `.build/reference/ffmpeg` at test time, after checking from `.build/reference/build-metadata.json` that it was built from commit 946fcce0 with `--disable-x86asm`. It ran in the sandbox against a reference built there (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64, Node v24.11.1) in about 12 s with `--maxWorkers=1`. The inputs are LCG noise, ramps with 0/255 edges, constant planes with spikes, and structured colour ramps.

| Test title | Paths | Platforms | Comparisons |
|---|---|---|---|
| `matches native colorcontrast identity settings for every format and size on the kernel and the CLI` | kernel, linear CLI | all | 7 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 5 identity settings, 3 frames, native output equal to the input and to the kernel: 210; plus 7 formats x 5 settings x {rawvideo, framecrc} through `-vf colorcontrast,hflip`: 70; 280 |
| `matches native colorcontrast float frames for every format, size and setting on linux-x64` | kernel | linux-x64 | 7 formats x 6 sizes x 10 settings, 3 frames: 420 |
| `matches native colorcontrast over structured colour ramps on linux-x64` | kernel | linux-x64 | 7 formats x 10 settings on 64x64 frames: the 16^3 grid of channel values, per-channel 0..255 ramps over 0/64/128/255, and grey and near-grey walks: 70 |
| `matches native colorcontrast with default threads and -filter_threads 1 on linux-x64` | kernel | linux-x64 | 3 formats x 2 sizes x 3 settings, native default, 4 and 1 threads equal and equal to the kernel: 18 |
| `matches native colorcontrast CLI rawvideo and framecrc through -vf and -filter_complex on linux-x64` | linear, graph (CLI) | linux-x64 | 8 source/setting pairs x {-vf, -filter_complex} x 3 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`}: 192 |
| `matches native replayed colorcontrast branches and joins frame by frame on linux-x64` | stream | linux-x64 | 8 pairs x 3 graphs (plain, split + hstack, transpose + nullsink): 24, plus 8 graph negotiations |
| `matches native colorcontrast framecrc and rawvideo through the actor and timed schedulers on linux-x64` | actor (`activation`, `producer`), timed (`pull`) | linux-x64 | 8 pairs x 2 chains x 2 muxers x 2 frame counts x 3 schedulers: 192 |
| `refuses colorcontrast timelines, unparsable and out-of-range values before opening CLI outputs on every backend` | linear, graph, actor/timed CLI | all | 4 native-accepted `enable=` forms x {-vf, -filter_complex} x {media, timed}: 16 refusals with no output opened; 10 out-of-range or unparsable values that native also refuses x {media, timed}: 20; 36 |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | all five | all | 2 identity filters x 17 sources: every pick matched byte-exact (yuvj sources on linear only), 73 checks each, 146 |

Total: 1,378 native comparisons (916 linux-gated, 462 everywhere), plus the build check.

`tests/unit/video-colorcontrast.test.ts` (7 tests) covers parsing (shorthand, named options, constants, expressions, float storage), every refusal, the format list, the `FLT_EPSILON` identity boundary, single-pixel values measured from the reference build, the rgba map orders, gbrp plane order, alpha copying, ownership, no mutation, `maxFrameBytes`, malformed strides, invalid settings, `AbortSignal`, the linear, graph and actor planners, and the runtime-command refusals. The unit tests compute in JavaScript only and run everywhere.

## Proposed test contracts

| id | File | Title | Modes | Platforms |
|---|---|---|---|---|
| `filter.colorcontrast.identity` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast identity settings for every format and size on the kernel and the CLI` | linear | all |
| `filter.colorcontrast.kernel` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast float frames for every format, size and setting on linux-x64` | linear | linux-x64 |
| `filter.colorcontrast.ramps` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast over structured colour ramps on linux-x64` | linear | linux-x64 |
| `filter.colorcontrast.threads` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast with default threads and -filter_threads 1 on linux-x64` | linear | linux-x64 |
| `filter.colorcontrast.cli` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast CLI rawvideo and framecrc through -vf and -filter_complex on linux-x64` | linear, graph | linux-x64 |
| `filter.colorcontrast.stream` | `tests/differential/video-colorcontrast.test.ts` | `matches native replayed colorcontrast branches and joins frame by frame on linux-x64` | graph, stream | linux-x64 |
| `filter.colorcontrast.timed` | `tests/differential/video-colorcontrast.test.ts` | `matches native colorcontrast framecrc and rawvideo through the actor and timed schedulers on linux-x64` | actor, timed | linux-x64 |
| `filter.colorcontrast.refusals` | `tests/differential/video-colorcontrast.test.ts` | `refuses colorcontrast timelines, unparsable and out-of-range values before opening CLI outputs on every backend` | linear, graph, actor, timed | all |
| `filter.colorcontrast.negotiation` | `tests/differential/video-colorcontrast.test.ts` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed | all |
| `filter.colorcontrast.syntax` | `tests/unit/video-colorcontrast.test.ts` | `refuses out-of-range, NaN and malformed values, timelines and unknown options before planning` | unit | all |

## Unsupported scope

- High-depth formats (`gbrp9..16`, `gbrap10..16`, `rgb48`, `bgr48`, `rgba64`, `bgra64`; `colorcontrast_slice16` and `_slice16p`), `gbrap` and the `0rgb`/`rgb0` family: no frame storage here. No negotiation source picks them; one that did would be refused by name.
- `enable=` timelines and runtime commands.
