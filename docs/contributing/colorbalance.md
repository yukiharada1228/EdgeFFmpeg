# colorbalance video filter

`colorbalance` shifts red, green and blue in the shadows, midtones and highlights, optionally restoring the input lightness. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorbalance.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-COLORBALANCE`; the descriptor is `packages/avfilter/src/video-ops/colorbalance.ts`.

## Syntax

`colorbalance[=rs:gs:bs:rm:gm:bm:rh:gh:bh:pl]`, or the same names as named options in any order. Later occurrences of an option win. The shorthand order is the AVOption order.

| Option | Type | Range | Default |
|---|---|---|---|
| `rs`, `gs`, `bs` (shadows), `rm`, `gm`, `bm` (midtones), `rh`, `gh`, `bh` (highlights) | `AV_OPT_TYPE_FLOAT` | -1..1 | 0 |
| `pl` (preserve lightness) | `AV_OPT_TYPE_BOOL` | 0..1 | 0 |

A balance is a constant decimal (`0.5`, `.3`, `-1`, `1e-1`, `+.5`) or one of set_string_number's constants `default` (0), `max` (1), `min` (-1), `none` (0) and `all` (~0, that is -1). It is range-checked as a double and then stored as a float (`Math.fround`), as `write_number` does. `pl` takes the AV_OPT_TYPE_BOOL spellings (`true`/`false`, `yes`/`no`, `y`/`n`, `on`/`off`, `enable(d)`/`disable(d)`, integers, empty for 0). A value outside its range fails with `Invalid colorbalance <option>: value outside -1..1` or `Invalid colorbalance pl: …`; native also exits non-zero for these.

## Supported and refused forms

- **Supported:** every balance in -1..1 and both `pl` values.
- **Non-constant values** (`1/3`, `0x1`, `1k`, `nan`, `inf`, `sin(0)`): `Only constant decimal colorbalance <option> values are implemented`. Native evaluates them with av_expr.
- **`enable=`:** `Colorbalance timeline expressions are not implemented`. Native supports the generic timeline.
- **Runtime commands:** native has `ff_filter_process_command` with every option `AV_OPT_FLAG_RUNTIME_PARAM`. The descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer every command with the unsupported code.
- **Any other option** (for example `threads`, which native accepts): `Unsupported colorbalance option`.
- Frames in a format other than the seven below, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings (outside -1..1, not a float, wrong count) and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every row and every 4096 pixels.

Every option refusal happens while parsing, before negotiation, input reads or output opens, on every path.

## Formats

`formats()` is the native `pix_fmts` list in declared order with native-endian names, 24 formats: `rgb24 bgr24 rgba bgra abgr argb 0bgr 0rgb rgb0 bgr0 rgb48le bgr48le rgba64le bgra64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le`. Frames run in the seven members with frame storage here, in that declared order: `rgb24`, `bgr24`, `rgba`, `bgra`, `abgr`, `argb` and `gbrp`. The shared negotiators refuse any pick without storage by name. Native's picks were measured from all 17 negotiation sources and every one has storage: yuva420p negotiates `argb`, gbrp stays `gbrp`, packed RGB stays as is, and every other YUV and gray source negotiates `rgb24`.

## Arithmetic

Per pixel, as `color_balance8` (packed) and `color_balance8_p` (gbrp), in IEEE single precision with every operation rounded by `Math.fround` and no fused multiply-add:

1. `r = R / 255.f`, likewise g and b; `l = FFMAX3(r,g,b) + FFMIN3(r,g,b)`.
2. `get_component` with `a = 4.f`, `b = 0.333f`, `scale = 0.7f`: the shadow, midtone and highlight weights are clipped ramps of `l`, each multiplied by `scale` and the option, then added to the component in the source order and clipped to 0..1. `av_clipf` is `FFMIN(FFMAX(a, amin), amax)`, so NaN becomes `amin`.
3. With `pl`, `preservel` computes the hue and saturation of the balanced components and `hfun` rebuilds them at half the input `l`. `fmodf` is exact (JavaScript `%` of a float is already a float). Black and white inputs divide by zero there (`1 - |2l - 1| = 0`): IEEE inf/NaN propagate as in C and `av_clipf` turns the NaN into 0, so such pixels become 0. The differential cases include them.
4. `lrintf(v * 255.f)` with ties to even, then `av_clip_uint8`.

Alpha (rgba, bgra, abgr, argb) is copied, which equals native whether it writes in place or into a new buffer. gbrp planes are G, B, R. With every balance 0 and `pl` off, every byte is unchanged (checked for all 256 values in the unit test and against native in the differential test).

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry examples run from the 8x8 gray source, which native negotiates to `rgb24`; three of them start with `format=gbrp`, `format=rgba` and `format=rgb24`.

## Determinism

Single-precision float per pixel without libm transcendentals (only `fmodf`, which is exact, and `lrintf`). The x86-64 reference build (`--disable-x86asm`, GCC, SSE scalar float, no FMA) rounds every operation, which `Math.fround` reproduces exactly. macOS arm64 may contract multiply-adds (for example `l - a * t` in `hfun` and the weight products in `get_component`), so every case with a non-zero balance or `pl` runs only on linux-x64; this gate is a precaution, since no macOS difference was measured in the sandbox. The defaults are the identity on every platform and run everywhere, as do the refusal and negotiation tests (the latter use the defaults). Slices are independent row ranges, so the output does not depend on the thread count: native with default slice threads and with `-filter_threads 1` agree, and both match here.

A mutation that drops `Math.fround` (double arithmetic) or rounds ties up fails all six float tests.

## Evidence

`tests/differential/video-colorbalance.test.ts` runs `.build/reference/ffmpeg` at test time, after checking from `.build/reference/build-metadata.json` that it was built from commit 946fcce0 with `--disable-x86asm`. It ran in the sandbox against a reference built there (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64, Node v24.22.3). Inputs are LCG noise, ramps with 0/255 edges, constant planes and a structured colour cube.

| Test title | Paths | Platforms | Comparisons |
|---|---|---|---|
| `matches native colorbalance defaults as the identity for every format and size` | kernel | all | 7 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 4 default spellings, 3 frames: 168 (native equals input, kernel equals native) |
| `matches native colorbalance frames for every format, size and balance (linux-x64 float)` | kernel (`balanceVideoColors`) | linux-x64 | 7 formats x 6 sizes x 13 balances (extremes, typical, shorthand, constants, `pl` with black/white saturation), 3 frames: 546 |
| `matches native colorbalance over a structured colour cube for every balance at its extremes (linux-x64 float)` | kernel | linux-x64 | 54^3 colours (0..255 step 5 plus 1 and 254) as rgb24 and gbrp x 56 settings (each balance alone at -1, 0.37 and 1, and all nine together, each with `pl` off and on): 112 |
| `matches native colorbalance with default slice threads and -filter_threads 1 (linux-x64 float)` | kernel | linux-x64 | 3 formats x 3 balances on 17x64 frames: 9 cases, 18 native runs |
| `matches native colorbalance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)` | linear, graph (CLI) | linux-x64 | 8 source/balance pairs x {-vf, -filter_complex} x 3 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`}: 192 |
| `matches native replayed colorbalance branches and joins frame by frame (linux-x64 float)` | stream | linux-x64 | 8 pairs x 3 graphs (plain, split + hstack, transpose + nullsink): 24, plus 8 graph negotiations |
| `matches native colorbalance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)` | actor (`activation`, `producer`), timed (`pull`) | linux-x64 | 8 pairs x 2 chains x 2 muxers x 2 frame counts x 3 schedulers: 192 |
| `refuses colorbalance timelines and unimplemented values before opening CLI outputs` | linear, graph, actor/timed CLI | all | 6 native-accepted forms x {-vf, -filter_complex} x {media, timed}: 24 refusals with no output opened; 4 out-of-range values that native also refuses: 28 |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | all five | all | 2 default filters x 17 sources, every pick matched byte-exact (yuvj sources on linear only), 73 checks each: 146 |

Total: 1,417 native comparisons, plus the build check. The file runs in about 17 s with `--maxWorkers=1`.

`tests/unit/video-colorbalance.test.ts` (7 tests) covers parsing, every refusal, the format list, identity for all 256 values, `get_component` and the black/white NaN saturation of `preservel`, the rgba map orders, gbrp plane order, ownership, no mutation, `maxFrameBytes`, malformed strides, settings validation, `AbortSignal`, and the linear, graph and actor planners.

## Proposed test contracts

| id | File | Title | Modes | Platforms |
|---|---|---|---|---|
| `filter.colorbalance.defaults` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance defaults as the identity for every format and size` | linear | all |
| `filter.colorbalance.kernel` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance frames for every format, size and balance (linux-x64 float)` | linear | linux-x64 |
| `filter.colorbalance.cube` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance over a structured colour cube for every balance at its extremes (linux-x64 float)` | linear | linux-x64 |
| `filter.colorbalance.threads` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance with default slice threads and -filter_threads 1 (linux-x64 float)` | linear | linux-x64 |
| `filter.colorbalance.cli` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)` | linear, graph | linux-x64 |
| `filter.colorbalance.stream` | `tests/differential/video-colorbalance.test.ts` | `matches native replayed colorbalance branches and joins frame by frame (linux-x64 float)` | graph, stream | linux-x64 |
| `filter.colorbalance.timed` | `tests/differential/video-colorbalance.test.ts` | `matches native colorbalance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)` | actor, timed | linux-x64 |
| `filter.colorbalance.refusals` | `tests/differential/video-colorbalance.test.ts` | `refuses colorbalance timelines and unimplemented values before opening CLI outputs` | linear, graph, actor, timed | all |
| `filter.colorbalance.negotiation` | `tests/differential/video-colorbalance.test.ts` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed | all |
| `filter.colorbalance.syntax` | `tests/unit/video-colorbalance.test.ts` | `refuses timelines, out-of-range and non-constant values, and unknown options before planning` | unit | all |

## Unsupported scope

- 16-bit packed (`rgb48`, `bgr48`, `rgba64`, `bgra64`), 9..16-bit planar, `gbrap` and the `0rgb`/`rgb0` family: no frame storage here (`color_balance16`, `color_balance16_p` are not ported). No negotiation source picks them; one that did would be refused by name.
- Non-constant option expressions, `enable=` timelines, runtime commands and generic options such as `threads`.
