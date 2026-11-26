# colorize

`colorize` overlays a solid HSL colour on planar YUV video. It replaces both chroma planes with the colour's U and V, and blends luma towards the colour's Y by `mix`. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_colorize.c` (`lerpf`, `colorizey_slice8`, `colorize_slice8`, `hue2rgb`, `hsl2rgb`, `rgb2yuv`, `filter_frame`, `config_input`) at `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Provenance: `packages/avfilter/NOTICE-COLORIZE`.

## Syntax

```
colorize[=hue:saturation:lightness:mix]
colorize=hue=<float>:saturation=<float>:lightness=<float>:mix=<float>
```

- `hue` defaults to 0 and takes 0 to 360. `saturation` defaults to 0.5, `lightness` to 0.5 and `mix` to 1, and each takes 0 to 1. The shorthand order is the native AVOption order.
- Each value is a decimal number with an optional sign, fraction and exponent (`12.5`, `.5`, `1.`, `5e-1`). As AV_OPT_TYPE_FLOAT does, the double is range-checked against the declared bounds and then stored as a float (`Math.fround`), so `hue=0.1` is stored as `0.100000001…`.
- If a key is repeated, the last value wins.

Explicit refusals, raised before any output is written:

- values outside the declared ranges, such as `hue=361`, `saturation=-0.1` or `mix=2`. Native also fails these, with a non-zero status;
- native expression forms the scoped parser does not evaluate: `1+1`, `0x10`, SI suffixes (`1k`), constants (`max`, `default`), `inf`, `nan` and empty values. Native accepts several of these;
- `enable=` (timeline), `threads=`, `h` and every other option, and a fifth positional value;
- runtime commands (`hue`, `saturation`, `lightness`, `mix` and `enable` are runtime parameters natively). They are refused automatically, because the descriptor sets neither `timeline` nor `geometryCommands`: the actor path answers ENOSYS (-38), and `enable` answers AVERROR_PATCHWELCOME (-1163346256).

## Formats

`formats()` returns native `pixel_fmts` in declared order (42 formats: planar YUV and YUVA at every depth, `yuvj` included, native-endian names), so the shared negotiators pick exactly what native picks. Frames run in `yuv420p`, `yuv422p`, `yuv444p` and `yuva420p`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. `frame()` refuses every other layout and checks the plane count, strides, storage, timestamp time base and allocation budget.

The `yuva420p` alpha plane is copied: native filters in place on a writable frame (`AVFILTERPAD_FLAG_NEEDS_WRITABLE`), so its output alpha is the input alpha, never uninitialised memory.

Native converts gray to full-range `yuvj444p` and packed RGB with alpha (rgba, bgra, argb, abgr) to `yuva444p`. Neither has frame storage here, so the negotiators refuse them at plan time with `Video filter colorize input negotiates <format>, which is not implemented`, on every path and before any output is opened. The other implicit conversions match native: nv12/nv21 to yuv420p, and rgb24, bgr24 and gbrp to yuv444p, with `-cpuflags 0` (scalar arithmetic). The registry examples start with an explicit `format=`, because they run from a gray source.

## Arithmetic and determinism

`filter_frame` computes the colour once per frame (the options are constant here):

- `hsl2rgb` and `hue2rgb` are single precision. Every operation is rounded with `Math.fround` in C evaluation order, unfused, as the x86-64 baseline evaluates it. The constants `1.f/3.f`, `1.f/6.f` and `2.f/3.f` are the float quotients.
- `rgb2yuv` is double precision, because its coefficients are double literals. `(int)` truncation is `|0`. The depth is always 8, so the scale is 255.
- `colorizey_slice8` computes `lerpf(c[0], y, mix)` as `fround(c0 + fround(fround(y - c0) * mix))`, and the `uint8_t` store truncates it. `colorize_slice8` fills every chroma sample of the subsampled planes (`AV_CEIL_RSHIFT` sizes) with `c[1]` and `c[2]`.

Slices split on the chroma height, and each slice writes disjoint rows, so native bytes do not depend on the thread count. A test compares native with default threads and `-filter_threads 1`.

Platform gating. macOS arm64 contracts the `a + b * c` expressions of `hue2rgb`, `lerpf` and `rgb2yuv` into fused multiply-adds, while the x86-64 baseline (and `Math.fround` emulation) does not. Probing found that the float rounding of HSL changes `c[]` only next to truncation boundaries. For example, `lightness=1` puts Y next to 219, as with `180.81:0.882:1`. Every test whose bytes depend on that arithmetic therefore runs only on linux-x64, has a constant title ending in `(Linux x64 unfused float)`, and is skipped elsewhere with `it.skipIf`. No case is dropped inside a test. No macOS arm64 run was available in this sandbox, so the gate is a precaution, not a measured difference.

The black overlays (`lightness=0`) run everywhere. They give `p = q = r = g = b = 0` exactly, so `c[]` is `(0,127,127)` whatever the contraction: `(0+0+0+0.5)*255` is exact. `lerpf(0, y, mix)` adds 0 to `y*mix`, which a fused multiply-add rounds identically. The per-source negotiation test uses such an overlay, so it also runs everywhere.

Mutation checks in this sandbox: computing the luma lerp in double fails 4 gated tests, and computing HSL in double fails the colour-ramp test.

## Paths

The descriptor flags `linear`, `graph`, `stream`, `actor` and `timed`. Each is covered by a differential test. The operator is stateless, so `actor` and `timed` call `frame()`.

## Evidence

All comparisons are byte-exact against `.build/reference/ffmpeg`, run at test time. The first test reads `.build/reference/build-metadata.json` and asserts commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` and `--disable-x86asm`. Sandbox reference: Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c` (unpinned bootstrap build), `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v24.22.3.

| Test (tests/differential/video-colorize.test.ts) | Platforms | Cases |
|---|---|---|
| uses a native reference built from 946fcce0 with --disable-x86asm | all | 1 |
| matches native linear colorize rawvideo for black overlays, which no multiply-add contraction can change | all | 168: 7 formats (yuv420p, yuv422p, yuv444p, yuva420p, yuvj420p, yuvj422p, yuvj444p) x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 4 options, 3 frames (noise, ramps, edges) |
| matches native linear colorize rawvideo across formats, sizes, options and noise, ramp, edge and constant inputs (Linux x64 unfused float) | linux-x64 | 840: 7 formats x 6 sizes x 20 options (defaults, each option at 0, its maximum and a typical value, hue sectors, joint extremes), 3 frames |
| matches native colorize c[] over a hue, saturation and lightness grid on constant 1x1 frames (Linux x64 unfused float) | linux-x64 | 446: 22 hues (sector edges ±0.01) x 4 saturations x 5 lightnesses, plus 6 points where double HSL would differ, luma 0, 128 and 255 at mix 0.5 |
| matches native colorize -vf and -filter_complex CLI rawvideo and framecrc with time selection and implicit conversions (Linux x64 unfused float) | linux-x64 | 720: 10 source/target pairs (4 storage formats, rgb24, bgr24→rgb24, gbrp, nv12→yuv420p, nv21, yuv420p→yuv444p) x 2 sizes x 3 chains x -vf/-filter_complex x rawvideo/framecrc x 3 time selections (none, input -ss with output -t, output -ss with -frames:v) |
| matches native colorize frame graphs and replayed streams with split and stack branches (Linux x64 unfused float) | linux-x64 | 64: 32 graph, 32 stream |
| matches native colorize through activation actors and the timed backend in rawvideo and framecrc (Linux x64 unfused float) | linux-x64 | 168: 24 actor, 144 timed CLI (rawvideo/framecrc x none, -frames:v 2, -ss/-t) |
| matches native colorize with default slice threads and -filter_threads 1 (Linux x64 unfused float) | linux-x64 | 16: 4 formats x 17x9 and 64x48 x 2 options. Native default threads equal native `-filter_threads 1`, and both equal EdgeFFmpeg |
| refuses colorize packed-alpha picks, out-of-range and unimplemented options and enable= before output where native accepts or fails them | all | 36: 9 refusals x -vf/-filter_complex x media/timed backend, with native's exit status recorded (0 for rgba, `1+1`, `max` and `enable=1`; non-zero for the range violations and `h`) |
| negotiates every accepted source as native does and refuses the picks without storage before output | all | `colorize=hue=100:saturation=0.9:lightness=0:mix=0.6` from 17 sources (`negotiationSources`), with native's pick read from showinfo. 12 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains). gray, argb, rgba, abgr and bgra are refused naming `yuvj444p` or `yuva444p`, on the five paths and through the media and timed CLIs, with no output opened. 93 checks |

The unit tests are in `tests/unit/video-colorize.test.ts` (5 tests). They cover parsing, float storage, ranges and refusals; `c[]` worked examples; the luma lerp, chroma fill and alpha copy; owned tight output and an unmutated padded input; `maxFrameBytes`, malformed strides, plane counts, invalid settings and AbortSignal; planner refusals of `yuvj444p`/`yuva444p` picks on the linear, graph and timed planners; and runtime-command refusal on the actor path.

## Proposed contracts

| id | file | name | modes | platforms | scope |
|---|---|---|---|---|---|
| filter.colorize.native-reference | tests/differential/video-colorize.test.ts | uses a native reference built from 946fcce0 with --disable-x86asm | semantic | all | build metadata commit and --disable-x86asm |
| filter.colorize.black-overlay | tests/differential/video-colorize.test.ts | matches native linear colorize rawvideo for black overlays, which no multiply-add contraction can change | semantic, bit-exact | all | lightness=0 overlays, 7 formats, 6 sizes, linear path |
| filter.colorize.linear-bytes | tests/differential/video-colorize.test.ts | matches native linear colorize rawvideo across formats, sizes, options and noise, ramp, edge and constant inputs (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | 7 formats, 6 sizes, 20 option sets, linear path |
| filter.colorize.color-ramp | tests/differential/video-colorize.test.ts | matches native colorize c[] over a hue, saturation and lightness grid on constant 1x1 frames (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | HSL grid and float-sensitive points |
| filter.colorize.cli | tests/differential/video-colorize.test.ts | matches native colorize -vf and -filter_complex CLI rawvideo and framecrc with time selection and implicit conversions (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | media backend -vf/-filter_complex, rawvideo/framecrc, -ss/-t/-frames:v, implicit conversions |
| filter.colorize.graph-stream | tests/differential/video-colorize.test.ts | matches native colorize frame graphs and replayed streams with split and stack branches (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | graph and stream paths |
| filter.colorize.actor-timed | tests/differential/video-colorize.test.ts | matches native colorize through activation actors and the timed backend in rawvideo and framecrc (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | actor and timed paths |
| filter.colorize.threads | tests/differential/video-colorize.test.ts | matches native colorize with default slice threads and -filter_threads 1 (Linux x64 unfused float) | semantic, bit-exact | linux-x64 | native thread-count independence |
| filter.colorize.refusals | tests/differential/video-colorize.test.ts | refuses colorize packed-alpha picks, out-of-range and unimplemented options and enable= before output where native accepts or fails them | semantic | all | refusals before output with native status recorded |
| filter.colorize.negotiation | tests/differential/video-colorize.test.ts | negotiates every accepted source as native does and refuses the picks without storage before output | semantic, bit-exact | all | per-source negotiation on five paths |

The gated contracts are linux-x64 only, as a precaution, because no macOS arm64 difference has been measured.

## Unsupported

- High-bit-depth formats (the `colorizey_slice16` and `colorize_slice16` functions), as well as yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, yuva444p and yuva422p. None of them has frame storage here. A negotiation that picks one, such as gray (`yuvj444p`) or packed RGB with alpha (`yuva444p`), is refused by name before output.
- `enable=` and runtime commands.
- Expression-valued options, constants and SI suffixes.
