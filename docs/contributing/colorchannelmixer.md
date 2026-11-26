# colorchannelmixer video filter

`colorchannelmixer` replaces each of R, G, B and A with a weighted sum of all four input channels. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorchannelmixer.c` and `colorchannelmixer_template.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-COLORCHANNELMIXER`; the descriptor is `packages/avfilter/src/video-ops/colorchannelmixer.ts`.

## Syntax

`colorchannelmixer[=rr:rg:rb:ra:gr:gg:gb:ga:br:bg:bb:ba:ar:ag:ab:aa:pc:pa]`, or the same names as named options in any order. Later occurrences of an option win. The shorthand order is the AVOption order.

| Option | Type | Range | Default |
|---|---|---|---|
| `rr`, `gg`, `bb`, `aa` | `AV_OPT_TYPE_DOUBLE` | -2..2 | 1 |
| the other twelve gains (`rg`, `rb`, `ra`, `gr`, `gb`, `ga`, `br`, `bg`, `ba`, `ar`, `ag`, `ab`) | `AV_OPT_TYPE_DOUBLE` | -2..2 | 0 |
| `pc` | `AV_OPT_TYPE_INT`, unit `preserve` | 0..6 | `none` (0) |
| `pa` | `AV_OPT_TYPE_DOUBLE` | 0..1 | 0 |

A gain or `pa` is a constant decimal (`0.5`, `.393`, `-1`, `1e-1`, `+.5`) or one of set_string_number's constants `default`, `max`, `min` and `none`. `pc` is a constant decimal rounded half to even, or a unit constant (`none`, `lum`, `max`, `avg`, `sum`, `nrm`, `pwr`), which wins over `default`/`max`/`min`/`none`/`all` as in native. A value outside its range fails with `Invalid colorchannelmixer <option>: value outside <range>`, as native does (native exits non-zero too).

## Supported and refused forms

- **Supported:** every gain in -2..2, `pc=none` (or any value rounding to 0) and any `pa` in 0..1. With `pc=none` native takes `filter_slice[0]`, which never reads `pa`, so `pa` has no effect; the differential tests include `pc=none:pa=0.75`.
- **`pc` other than none** (`lum`, `max`, `avg`, `sum`, `nrm`, `pwr`, 1..6): `Colorchannelmixer color preservation (pc other than none) is not implemented`. That path clips to float, calls `preserve_color` (`cbrtf` for `pwr`), `lerpf` and `lrintf`, which is float arithmetic not adapted here; `pa` with it is refused with it. Native accepts these.
- **Non-constant values** (`1/3`, `0x1`, `1k`, `nan`, `inf`, function calls, `pc=lum+0`): `Only constant decimal colorchannelmixer <option> values are implemented`. Native evaluates them with av_expr.
- **`enable=`:** `Colorchannelmixer timeline expressions are not implemented`. Native supports the generic timeline.
- **Runtime commands:** native's `process_command` rebuilds the tables. The descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer every command with the unsupported code.
- **Any other option** (for example `threads`): `Unsupported colorchannelmixer option`.
- Frames in a format other than the seven below, malformed planes or strides, budgets over `maxFrameBytes`, invalid gains and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every row and every 4096 pixels.

Every refusal happens while parsing, before negotiation, input reads or output opens, on every path.

## Formats

`formats()` is the native `pix_fmts` list in declared order with native-endian names, 26 formats: `rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 rgb48le bgr48le rgba64le bgra64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le gbrpf32le gbrapf32le`. Frames run in the seven members with frame storage here: `rgb24`, `bgr24`, `rgba`, `bgra`, `argb`, `abgr` and `gbrp`. Any negotiation that picks another member is refused by name. Native's picks were measured from all 17 negotiation sources, and every one has storage: yuva420p negotiates `argb`, gbrp stays `gbrp`, packed RGB stays as is, and every other YUV and gray source negotiates `rgb24`.

## Arithmetic

`config_output` builds sixteen 256-entry `int` tables, `lut[i][j][v] = lrint(v * gain)`: one IEEE double multiply, then round to nearest with ties to even (the default rounding mode). The tables are rebuilt per frame here; they are 16 KiB and depend only on the step. Each output channel is the sum of four table entries (three without alpha), clipped by `av_clip_uintp2(…, 8)` to 0..255.

- Packed formats use the `ff_fill_rgba_map` byte offsets (rgb24 0/1/2, bgr24 2/1/0, rgba 0/1/2/3, bgra 2/1/0/3, argb 1/2/3/0, abgr 3/2/1/0). rgb24 and bgr24 have no alpha: the `ra`, `ga`, `ba` terms and the alpha row are not applied.
- `gbrp` planes are G, B, R. `filter_slice_gbrp` passes `have_alpha=0`, so the alpha terms are not applied.
- Every pixel is overwritten, so writing in place (native) or into a new buffer (here) gives the same output.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry examples run from the 8x8 gray source, which native negotiates to `rgb24`.

## Determinism

One double multiply and `lrint` per table entry, then integer sums and clips: no fusable expression, no float accumulation and no libm call. The x86 assembly is disabled in the Linux reference and the filter has no assembly anyway. Slices are independent row ranges, so the output does not depend on the thread count. No case is gated to a platform.

## Evidence

`tests/differential/video-colorchannelmixer.test.ts` runs `.build/reference/ffmpeg` at test time, after checking from `.build/reference/build-metadata.json` that it was built from commit 946fcce0 with `--disable-x86asm`. It ran in the sandbox against a reference built there (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64, Node v24.22.3). The inputs are LCG noise, ramps with 0/255 edges and constant planes. The mixes are identity, a sepia matrix, an averaging matrix, negative gains, alpha terms, products landing exactly on .5 (0.5, 1.5, 0.25, 0.125, 0.75, 1.25, 1.375, 0.375), the -2/2 range ends, a channel swap and `pc=none:pa=0.75`.

| Test title | Paths | Comparisons |
|---|---|---|
| `matches native colorchannelmixer frames for every format, size and mix` | kernel (`mixVideoChannels`) | 7 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 9 mixes, 3 frames each: 378 rawvideo byte matches |
| `matches native colorchannelmixer tables for every 8-bit value of every input channel` | kernel | 7 formats x 3 bases (0, 128, 255) x 4 tie-heavy and irregular gain sets on a 256x4 frame whose row k ramps channel k through 0..255: 84 matches, covering all 16 tables at every index |
| `matches native colorchannelmixer CLI rawvideo and framecrc through -vf and -filter_complex` | linear, graph (CLI) | 8 source/mix pairs x {-vf, -filter_complex} x 3 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`}: 192 |
| `matches native replayed colorchannelmixer branches and joins frame by frame` | stream | 8 pairs x 3 graphs (plain, split + hstack, transpose + nullsink): 24, plus 8 graph negotiations |
| `matches native colorchannelmixer framecrc and rawvideo through the actor and timed schedulers` | actor (`activation`, `producer`), timed (`pull`) | 8 pairs x 2 chains x 2 muxers x 2 frame counts x 3 schedulers: 192 |
| `refuses colorchannelmixer preserve modes, timelines and unimplemented values before opening CLI outputs` | linear, graph, actor/timed CLI | 6 native-accepted forms x {-vf, -filter_complex} x {media, timed}: 24 refusals with no output opened; 3 out-of-range values that native also refuses: 27 |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | all five | 2 filters x 17 sources: every pick matched byte-exact (yuvj sources on linear only), 73 checks each, 146 |

Total: 1,043 native comparisons, plus the build check. A mutation that rounds ties away from zero (`Math.round`) fails six of the eight tests.

`tests/unit/video-colorchannelmixer.test.ts` (7 tests) covers parsing, every refusal, the format list, the tables' tie rounding, an independent reference of the packed mix, the rgba map orders, gbrp plane order, ownership, no mutation, `maxFrameBytes`, malformed strides, `AbortSignal`, and the linear, graph and actor planners.

## Proposed test contracts

| id | File | Title | Modes |
|---|---|---|---|
| `filter.colorchannelmixer.kernel` | `tests/differential/video-colorchannelmixer.test.ts` | `matches native colorchannelmixer frames for every format, size and mix` | linear |
| `filter.colorchannelmixer.tables` | `tests/differential/video-colorchannelmixer.test.ts` | `matches native colorchannelmixer tables for every 8-bit value of every input channel` | linear |
| `filter.colorchannelmixer.cli` | `tests/differential/video-colorchannelmixer.test.ts` | `matches native colorchannelmixer CLI rawvideo and framecrc through -vf and -filter_complex` | linear, graph |
| `filter.colorchannelmixer.stream` | `tests/differential/video-colorchannelmixer.test.ts` | `matches native replayed colorchannelmixer branches and joins frame by frame` | graph, stream |
| `filter.colorchannelmixer.timed` | `tests/differential/video-colorchannelmixer.test.ts` | `matches native colorchannelmixer framecrc and rawvideo through the actor and timed schedulers` | actor, timed |
| `filter.colorchannelmixer.refusals` | `tests/differential/video-colorchannelmixer.test.ts` | `refuses colorchannelmixer preserve modes, timelines and unimplemented values before opening CLI outputs` | linear, graph, actor, timed |
| `filter.colorchannelmixer.negotiation` | `tests/differential/video-colorchannelmixer.test.ts` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed |
| `filter.colorchannelmixer.syntax` | `tests/unit/video-colorchannelmixer.test.ts` | `refuses preserve modes, timelines, out-of-range and non-constant values, and unknown options before planning` | unit |

Every platform; none is gated to linux-x64.

## Unsupported scope

- `pc` other than `none` (the float preserve path) and therefore `pa` with it.
- 16-bit packed (`rgb48`, `bgr48`, `rgba64`, `bgra64`), 9..16-bit planar, `gbrap`, float (`gbrpf32`, `gbrapf32`) and the `0rgb`/`rgb0` family: no frame storage here. No negotiation source picks them; one that did would be refused by name.
- Non-constant option expressions, `enable=` timelines and runtime commands.
