# vibrance video filter

`vibrance` boosts or alters saturation: each of R, G and B moves away from (or towards) the pixel's luma by a factor that depends on the pixel's saturation. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_vibrance.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-VIBRANCE`; the descriptor is `packages/avfilter/src/video-ops/vibrance.ts`.

## Syntax

`vibrance[=intensity:rbal:gbal:bbal:rlum:glum:blum:alternate]`, or the same names as named options in any order. Later occurrences of an option win. The shorthand order is the AVOption order.

| Option | Type | Range | Default |
|---|---|---|---|
| `intensity` | `AV_OPT_TYPE_FLOAT` | -2..2 | 0 |
| `rbal`, `gbal`, `bbal` | `AV_OPT_TYPE_FLOAT` | -10..10 | 1 |
| `rlum` | `AV_OPT_TYPE_FLOAT` | 0..1 | 0.212656 |
| `glum` | `AV_OPT_TYPE_FLOAT` | 0..1 | 0.715158 |
| `blum` | `AV_OPT_TYPE_FLOAT` | 0..1 | 0.072186 |
| `alternate` | `AV_OPT_TYPE_BOOL` | 0..1 | 0 |

A float option is a constant decimal (`0.5`, `.5`, `-1`, `1e-1`, `+.25`) or one of set_string_number's constants `default`, `max`, `min`, `none` (0) and `all` (-1). The value is range-checked as a double, as `write_number` does, and stored with `Math.fround`, as the float field stores it. `alternate` accepts `true`, `y`, `yes`, `enable`, `enabled`, `on`, their false counterparts (case-insensitive), the empty string and decimal integers, as `set_string_bool` does. A value outside its range fails with `Invalid vibrance <option>: value outside <range>`; native exits non-zero on the same inputs (`alternate=auto` is -1, outside 0..1).

## Supported and refused forms

- **Supported:** every option value in range, by shorthand or by name.
- **Non-constant values** (`1/3`, `2*2`, `0x1`, `1k`, `nan`, `inf`, `PI`, function calls): `Only constant decimal vibrance <option> values are implemented`. Native evaluates them with av_expr.
- **`enable=`:** `Vibrance timeline expressions are not implemented`. Native supports the generic timeline.
- **Runtime commands:** native's `process_command` is `ff_filter_process_command`, and every option is `AV_OPT_FLAG_RUNTIME_PARAM`. The descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer every command with the unsupported code.
- **Any other option** (for example the generic `threads`): `Unsupported vibrance option`. More than eight positional values fail as in native.
- Frames in a format other than the seven below, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings (out of range or not single precision) and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every row and every 4096 pixels.

Every option refusal happens while parsing, before negotiation, input reads or output opens, on every path.

## Formats

`formats()` is the native `pixel_fmts` list in declared order with native-endian names, 24 formats: `rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le rgb48le bgr48le rgba64le bgra64le`. Frames run in the seven members with frame storage here: `rgb24`, `bgr24`, `rgba`, `bgra`, `argb`, `abgr` and `gbrp`. Any negotiation that picks another member is refused by the shared negotiators by name. Native's picks were measured from all 17 negotiation sources, and every one has storage: yuva420p negotiates `argb`, gbrp stays `gbrp`, packed RGB stays as is, and every other YUV and gray source negotiates `rgb24`.

## Arithmetic

`config_input` selects `vibrance_slice8p` for the packed formats (offsets from `ff_fill_rgba_map`: rgb24 0/1/2, bgr24 2/1/0, rgba 0/1/2/3, bgra 2/1/0/3, argb 1/2/3/0, abgr 3/2/1/0; step `nb_components`) and `vibrance_slice8` for gbrp (planes G, B, R). Per pixel, in IEEE single precision with every operation rounded (`Math.fround`) and nothing fused:

```
g = G * (1/255f)  (same for b, r)
saturation = max3(r, g, b) - min3(r, g, b)
luma = (g*glum + r*rlum) + b*blum
k_c = intensity * cbal;  s_c = (alternate ? 1 : -1) * (k_c > 0 ? 1 : -1)     // FFSIGN(0) is -1
c_c = 1 + k_c * (1 - s_c * saturation)
out_c = av_clip_uint8((int)((luma + (v_c - luma) * c_c) * 255f))               // lerpf, then truncation toward zero
```

The alpha byte of rgba, bgra, argb and abgr is copied. The defaults are **not** an identity: `luma + (v - luma)` rounds in float and the store truncates, so some values drop by one (measured on the full 256^3 cube natively, reproduced here).

Every pixel is overwritten from the input, so writing into a new buffer (here) gives the same output as native writing in place or into a new buffer, with one exception below.

### Native defects with non-writable input and slice threads

When the input frame is not writable (for example a `split` output), native allocates a new output frame and has two defects that only show with more than one slice job:

- `vibrance_slice8` (gbrp) offsets the source planes by `slice_start * <output linesize>`, so slices after the first read the wrong rows whenever the input linesize differs from the output's.
- `vibrance_slice8p` stores `ptr[x * step + aoffset] = src[x * step + aoffset]` even for rgb24/bgr24, whose `aoffset` is 3: the last pixel of each row writes the first byte of the next row. That byte is rewritten when the next row runs in the same slice, but it races with the next slice when the output linesize equals `3 * width` (widths 64 and 128 here).

Both were measured: `-filter_complex '[0:v]split[x][y];[x]vibrance=intensity=2[l];[y]nullsink'` differs between default threads and `-filter_complex_threads 1` for gbrp at 5x3, 17x9 and 32x8 and for rgb24/bgr24 at 64x16 and 128x8 (rgba, argb, and gbrp at 64x16 and 128x8 agree), and the default-thread output even changes from run to run. It reads rows outside the input's rows and depends on scheduling, so it is not mirrored. This kernel produces the sequential result, which equals native with one filter thread. Writable inputs (plain `-vf` and `-filter_complex` chains) agree between default threads and one thread, and with this kernel.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry examples run from the 8x8 gray source, which native negotiates to `rgb24`; three examples start with `format=gbrp`, `format=rgba` and `format=bgr24` to cover the planar and other packed kernels.

## Determinism

The kernel is single-precision float with no libm transcendental: multiplies, adds, subtractions, max/min and one truncating conversion. x86-64 without FMA (the Linux reference is built with `--disable-x86asm` and the default `-ffp-contract` on a target without FMA instructions) evaluates every operation unfused, which `Math.fround` after every operation reproduces. macOS arm64 contracts multiply-adds such as `g*gc + r*rc` and `luma + (v - luma) * c`, which changes some results. Because the defaults are not an identity, the default case is float-sensitive too. Every differential test that compares pixels is therefore gated to linux-x64 with `it.skipIf`, under a constant title. No macOS difference was measured in this sandbox, so the gate is a precaution. The build check and the refusal test run on every platform.

Mutations that drop `Math.fround` (double precision throughout) or swap the order of the luma sum fail both the kernel and the cube tests.

## Evidence

`tests/differential/video-vibrance.test.ts` runs `.build/reference/ffmpeg` at test time, after checking from `.build/reference/build-metadata.json` that it was built from commit 946fcce0 with `--disable-x86asm`. It ran in the sandbox against a reference built there (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64, Node v24.22.3, 4 vCPUs). The inputs are LCG noise, ramps with 0/255 edges, constant planes and the full 8-bit RGB cube. The settings are the defaults, `intensity` at -2, 2 and typical values, each balance at -10, 0 and 10 and typical values, the luma coefficients at 0 and 1 and BT.601 values, `alternate` with positive, negative and zero intensity, the positional order, and the `max`/`min`/`none` constants.

| Test title | Paths | Comparisons | Platforms |
|---|---|---|---|
| `runs against the reference build of commit 946fcce0 configured with --disable-x86asm` | – | build check | all |
| `matches native vibrance frames for every format, size and setting (linux-x64 float)` | kernel (`vibranceVideoFrame`) | 7 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 18 settings, 3 frames each: 756 | linux-x64 |
| `matches native vibrance on every 8-bit RGB triple (linux-x64 float)` | kernel | the 256^3 cube on a 4096x4096 frame in rgb24, gbrp and bgra under 8 settings: 8 frames, 134M pixels | linux-x64 |
| `matches native vibrance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)` | linear, graph (CLI) | 8 source/setting pairs x {-vf, -filter_complex} x 3 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`}: 192 | linux-x64 |
| `matches native replayed vibrance branches and joins frame by frame (linux-x64 float)` | stream | 8 pairs x 3 graphs (plain, split + hstack, transpose + nullsink), native with `-filter_complex_threads 1`: 24, plus 8 graph negotiations | linux-x64 |
| `matches native vibrance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)` | actor (`activation`, `producer`), timed (`pull`) | 8 pairs x 2 chains x 2 muxers x 2 frame counts x 3 schedulers: 192 | linux-x64 |
| `matches native vibrance with default and single filter threads (linux-x64 float)` | kernel, native threads | 7 formats x 4 sizes (17x9, 64x16, 33x31, 128x8) x 3 settings: native default threads equal `-filter_threads 1` and the kernel (84), and the kernel equals native through a non-writable split with `-filter_complex_threads 1` (84): 168 | linux-x64 |
| `refuses vibrance timelines and unimplemented values before opening CLI outputs` | linear, graph, actor/timed CLI | 5 native-accepted forms x {-vf, -filter_complex} x {media, timed}: 20 refusals with no output opened; 8 out-of-range, `auto` or over-long values that native also refuses: 28 | all |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path (linux-x64 float)` | all five | 2 filters x 17 sources: every pick matched byte-exact (yuvj sources on linear only), 73 checks each: 146 | linux-x64 |

Total: 1,514 native comparisons, plus the build check. The file takes about 19 s with `--maxWorkers=1`.

`tests/unit/video-vibrance.test.ts` (6 tests) covers parsing, every refusal, the format list, an independent reference of the float kernel, alpha copy, every packed order, gbrp plane order, the non-identity defaults, ownership, no mutation, `maxFrameBytes`, malformed strides, invalid settings, `AbortSignal`, and the linear, graph and actor planners.

## Proposed test contracts

| id | File | Title | Modes | Platforms |
|---|---|---|---|---|
| `filter.vibrance.kernel` | `tests/differential/video-vibrance.test.ts` | `matches native vibrance frames for every format, size and setting (linux-x64 float)` | linear | linux-x64 |
| `filter.vibrance.cube` | `tests/differential/video-vibrance.test.ts` | `matches native vibrance on every 8-bit RGB triple (linux-x64 float)` | linear | linux-x64 |
| `filter.vibrance.cli` | `tests/differential/video-vibrance.test.ts` | `matches native vibrance CLI rawvideo and framecrc through -vf and -filter_complex (linux-x64 float)` | linear, graph | linux-x64 |
| `filter.vibrance.stream` | `tests/differential/video-vibrance.test.ts` | `matches native replayed vibrance branches and joins frame by frame (linux-x64 float)` | graph, stream | linux-x64 |
| `filter.vibrance.timed` | `tests/differential/video-vibrance.test.ts` | `matches native vibrance framecrc and rawvideo through the actor and timed schedulers (linux-x64 float)` | actor, timed | linux-x64 |
| `filter.vibrance.threads` | `tests/differential/video-vibrance.test.ts` | `matches native vibrance with default and single filter threads (linux-x64 float)` | linear, graph | linux-x64 |
| `filter.vibrance.refusals` | `tests/differential/video-vibrance.test.ts` | `refuses vibrance timelines and unimplemented values before opening CLI outputs` | linear, graph, actor, timed | all |
| `filter.vibrance.negotiation` | `tests/differential/video-vibrance.test.ts` | `negotiates every accepted source as native does and refuses picks without storage before output on every path (linux-x64 float)` | linear, graph, stream, actor, timed | linux-x64 |
| `filter.vibrance.syntax` | `tests/unit/video-vibrance.test.ts` | `refuses timelines, out-of-range and non-constant values, and unknown options before planning` | unit | all |

## Unsupported scope

- 9..16-bit planar (`gbrp9`..`gbrp16`, `gbrap10`..`gbrap16`), `gbrap`, 16-bit packed (`rgb48`, `bgr48`, `rgba64`, `bgra64`) and the `0rgb`/`rgb0` family: no frame storage here, so `vibrance_slice16`/`vibrance_slice16p` are not ported. No negotiation source picks them; one that did would be refused by name.
- Non-constant option expressions, `enable=` timelines and runtime commands.
- Native's thread-count-dependent output for non-writable input (see above); the sequential result is produced instead.
