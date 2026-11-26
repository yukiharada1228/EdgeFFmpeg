# lut, lutrgb and lutyuv video filters

`lut`, `lutrgb` and `lutyuv` build one lookup table per component from an expression and pass every pixel through it. They are adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_lut.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-LUT`. The three descriptors (`packages/avfilter/src/video-ops/lut.ts`, `lutrgb.ts`, `lutyuv.ts`) share one kernel, `packages/avfilter/src/video-lut.ts`.

## Syntax

`lut[=c0:c1:c2:c3:y:u:v:r:g:b:a]`, or the same names as named options, and the same for `lutrgb` and `lutyuv`. All three filters take all eleven options. Every option is an `AV_OPT_TYPE_STRING` expression and defaults to `clipval`.

| Options | Component |
|---|---|
| `c0`, `y`, `r` | 0 |
| `c1`, `u`, `g` | 1 |
| `c2`, `v`, `b` | 2 |
| `c3`, `a` | 3 |

Components follow the pixel descriptor: Y, U, V, A for YUV, gray for gray, and R, G, B, A for RGB, whatever the byte or plane order. When an option sets a component that an earlier option already set, the later value wins. Native `process_options` skips a shorthand only when its offset equals the offset of the option before it. So all eleven options are shorthand, and the fifth positional value sets `y`, which is component 0 (`lut=a:b:c:d:e` gives component 0 the expression `e`). The differential tests check both rules against native.

Expressions use the shared evaluator (`compileExpression`) with the variables `w` and `h` (the input size), `val`, `maxval`, `minval`, `negval` (`minval+maxval-val` clipped to the range) and `clipval` (`val` clipped to the range). Native `config_props` parses an expression only for the components the negotiated format has, so `lut=c1=clip(val)` runs on gray. The code here checks syntax at the same point, in `geometry()` on every path, before any output is opened.

## Supported and refused forms

- **Supported:** arithmetic, comparisons, `if()`/`ifnot()`, `between()`, `min`/`max`, `mod`, `floor`/`ceil`/`trunc`/`round`, `abs`, `sqrt`, `bitand`/`bitor`, `st`/`ld`, `random`, `while`, the constants `PI`, `E` and `PHI`, SI suffixes, the ported `log`, and libavutil's three-argument `clip()`. That builtin shadows vf_lut's one-argument `funcs1` clip. So `clip(val)` fails natively with status 234 (AVERROR(EINVAL), `Error when parsing the expression`), and here with `Invalid lut expression …`. `clip(val,16,235)` runs.
- **gammaval() and gammaval709():** refused in parse with `Lut gammaval() and gammaval709() are not implemented`. They need vf_lut's own `funcs1` (PREP-EXPR, deferred with geq) and they call `pow`. Native accepts them.
- **Unported builtins:** `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `exp`, `pow`, `gauss`, `squish`, plus `root` (which calls pow) and `time` (which is not deterministic). All are refused in parse with `Lut expression function <name>() is not implemented`. The `^` operator (pow) is refused with `Lut expression operator ^ is not implemented`. Native accepts all of them.
- **NaN:** native evaluates all 65536 entries of each table and fails with status 234 (`Error when evaluating the expression`) when any entry is NaN, including entries an 8-bit format never reads. Here the same case fails with `Lut expression '<e>' evaluates to NaN for component <n>`.
- **Values outside the int range:** native `(int)res` gives INT_MIN on x86-64 and saturates on AArch64, so the output depends on the platform. A used entry (0..255) whose value is not in (-2147483649, 2147483648), infinities included, is refused with `… gives a value outside the int range …`. Native x86-64 accepts it and writes 0. Unused entries are only checked for NaN.
- **Profile-dependent tables:** every table is built under both expression profiles (`linux-x64` and `darwin-arm64`). If the used entries differ, the table is refused with `Lut expression '<e>' depends on the numeric profile`. Today only `hypot` and `log` differ between the profiles. `hypot(val,20)` is refused: at val=99 the exact result is 101, and the two profiles truncate to different integers. Every `log` case tested agreed and runs.
- **Evaluator bounds:** 256 characters, and 10,000 evaluation steps for each entry. An expression past them fails with `Lut expression '<e>' failed for the value <v>: …`.
- **`enable=`:** refused with `Lut timeline expressions are not implemented` (or `Lutrgb …`, `Lutyuv …`). Native supports the generic timeline.
- **Runtime commands:** native's `process_command` reparses and rebuilds the tables. The descriptors set neither `timeline` nor `geometryCommands`, so the activation actors answer every command with the unsupported code.
- **Any other option** (for example `threads`): `Unsupported lut option` (or `lutrgb`, `lutyuv`).
- Frames in other formats, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every row and every 16384 bytes.

## Formats

`formats()` returns the native list in declared order with native-endian names:

- `lutyuv`: `yuv_pix_fmts`, 33 formats, from `yuv444p yuv422p yuv420p yuv411p yuv410p yuv440p yuva420p yuva422p yuva444p yuvj444p yuvj422p yuvj420p yuvj440p` through `yuva420p16le`.
- `lutrgb`: `rgb_pix_fmts`, 18 formats: `argb rgba abgr bgra rgb24 bgr24 rgb48le rgba64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrp14le gbrp16le gbrap12le gbrap16le`.
- `lut`: `all_pix_fmts`, which is the RGB list, then the YUV list, then `gray gray9le gray10le gray12le gray14le gray16le` (57 formats).

The yuvj formats appear explicitly in these lists, so `jpegSiblings` is not set. Frames run in the members with frame storage here:

- `gray`
- `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p`
- `rgb24`, `bgr24`, `rgba`, `bgra`, `argb`, `abgr`
- `gbrp`
- legacy `yuvj420p`, `yuvj422p` and `yuvj444p` links, which a yuvj source passes through on linear chains

The shared negotiators refuse every other pick by name.

Native picks, measured from all 17 negotiation sources:

| Filter | Picks |
|---|---|
| `lut` | Every source keeps its format, except nv12 and nv21, which become `yuv420p`. |
| `lutrgb` | Packed RGB(A) and gbrp stay as they are. yuva420p becomes `argb`. Every other YUV and gray source becomes `rgb24`. |
| `lutyuv` | Planar YUV and yuvj sources stay as they are. nv12 and nv21 become `yuv420p`. RGB24, BGR24 and gbrp become `yuv444p`. Gray becomes `yuvj444p` and packed alpha becomes `yuva444p`, which have no storage here, so these five sources are refused by name on every path before any output is opened. |

## Arithmetic

`config_props` builds, for each component, `lut[comp][val] = av_clip((int)res, 0, max[A])` for `val` from 0 to 65535, with one fresh `AVExpr` per component. That fresh context resets `st`/`ld` state and `random` seeds for each component, and the evaluation runs in ascending `val` order, both as here. The ranges are:

- **The four 8-bit YUV formats here (`yuv420p`, `yuv422p`, `yuv444p`, `yuva420p`):** Y 16..235, U and V 16..240, A 0..255.
- **Every other format here, legacy yuvj included:** 0..255 for every component (the `default` case).

`max[A]` is 255 for every 8-bit format. `(int)` truncates toward zero.

A legacy yuvj link reaches an operator as yuv storage tagged with `colorRange: 2`. For yuv420p, yuv422p and yuv444p frames, the kernel takes that tag as the yuvj format and builds the full-range tables native uses. The negotiation test matches native byte for byte on all three yuvj sources.

Application:

- **Planar formats:** plane `p` reads table `p`. For gbrp, `ff_fill_rgba_map` sends R, G and B to planes 2, 0 and 1, so the G, B, R planes read the g, b, r tables.
- **Packed RGB:** byte offset `o` of each pixel reads the table of the component at that offset (rgb24 0/1/2, bgr24 2/1/0, rgba 0/1/2/3, bgra 2/1/0/3, argb 1/2/3/0, abgr 3/2/1/0).
- **Ownership:** every byte is overwritten, so native's in-place write and the new owned planes here give the same output.

Tables are cached for each step and format. They are also cached for each size when an expression names `w` or `h`.

## Determinism

Each entry is node-by-node double arithmetic in the shared evaluator. No compiler contracts operations across `av_expr` nodes, the unported libm functions are refused, and the tables must agree under both numeric profiles, so the result does not depend on the profile. The only C conversion that depends on the platform, `(int)` of an out-of-range double, is refused. The output is applied with integers. Slices are independent row ranges, so threads do not change the output. No case is gated to linux-x64. No macOS run was made in this sandbox.

## Paths

The filters run on `linear`, `graph`, `stream`, `actor` and `timed`, all through the stateless `frame` function. `geometry()` keeps the size and builds (and so refuses) the tables against the negotiated input. The registry examples run from the 8x8 gray source: `lut` directly on gray, `lutrgb` after `format=rgb24`/`rgba`/`gbrp`, and `lutyuv` after `format=yuv420p`/`yuv444p`/`yuva420p`/`yuv422p`. A conversion is needed because native lutyuv picks yuvj444p from gray.

## Evidence

`tests/differential/video-lut.test.ts` runs `.build/reference/ffmpeg` at test time. It first checks in `.build/reference/build-metadata.json` that the binary was built from commit 946fcce0 with `--disable-x86asm`.

The tests ran in this sandbox against a reference built there:

- ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`
- `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`
- Linux x86_64, Node v24.22.3

The inputs are LCG noise, ramps with 0/255 edges and constant planes, three frames each. The twelve option strings are:

- the default
- `negval`
- `maxval-val`
- `val*2`
- `clip(val*3,16,235)`
- per-component `if()`/`between()`/range expressions
- `w`/`h` expressions with `trunc`
- `st`/`ld` state, `floor` and `random` with `minval`
- `log(val+1)*40`
- `if(between(val,minval,maxval),val*h/w,negval)`
- `mod` plus `bitand` with a hex literal
- positional negative, fractional, `PI`/`E` and comparison expressions

| Test title | Paths | Native comparisons |
|---|---|---|
| `matches native lut, lutrgb and lutyuv frames for every storage format, size and expression` | kernel (`lutVideoFrame`) | lut: 15 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 12 = 1080. lutrgb and lutyuv: 14 formats x 3 sizes x 12 = 504. Total 1584. |
| `matches native lut tables for every 8-bit value of every component` | kernel | 15 formats x 12 on a 256x1 ramp in every plane or component: 180 |
| `matches native lut CLI rawvideo and framecrc through -vf and -filter_complex, with and without -ss/-t` | linear, graph (CLI) | 9 filter/source/option triples x {-vf, -filter_complex} x 2 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.08`}: 144 |
| `matches native replayed lut branches, joins and the multi-input CLI frame by frame` | stream | 9 triples x 3 graphs (plain, split + hstack, transpose + nullsink) = 27, plus a two-input vstack CLI in 2 muxers. Total 29, plus 9 graph negotiations. |
| `matches native lut framecrc and rawvideo through the actor and timed schedulers` | actor (`activation`, `producer`), timed (`pull`) | 9 triples x 2 chains x 2 muxers x 2 frame counts x 3 schedulers: 216 |
| `fails like native on unparsable and NaN expressions and refuses gammaval, unported functions, int overflow and timelines before any output` | linear, graph, actor, timed (CLI) | 17 forms with native's exit status asserted: 234 for `clip(val)`, `0/0` and a NaN at val > 255; 0 for the native-accepted forms; non-zero for an unknown option. Each form runs x {-vf, -filter_complex, timed pull, timed producer}, with no output opened and the named message: 68 refusals. |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | all five | 3 filters x 17 sources: 73 + 73 + 93 = 239 checks |

That is 2,409 native comparisons in all, plus the build check and the 68 refusals. The file took 86 s in this sandbox.

`tests/unit/video-lut.test.ts` (10 tests) covers:

- parsing: the shorthand and alias rules, every parse refusal and the per-component syntax deferral
- the tables: limited and full ranges, truncation and clipping, `w`/`h` caching, state order, and the NaN, int-range, profile and budget refusals
- `geometry`
- the packed rgba maps, gbrp plane order and the legacy yuvj range
- padded strides, ownership, no mutation, `maxFrameBytes`, malformed strides, time bases and `AbortSignal`
- the three descriptors' format lists and flags

`tests/unit/video-operator-registry.test.ts` runs the thirteen examples on every path without edits.

## Proposed test contracts

| id | File | Title | Modes |
|---|---|---|---|
| `filter.lut.kernel` | `tests/differential/video-lut.test.ts` | `matches native lut, lutrgb and lutyuv frames for every storage format, size and expression` | linear |
| `filter.lut.tables` | `tests/differential/video-lut.test.ts` | `matches native lut tables for every 8-bit value of every component` | linear |
| `filter.lut.cli` | `tests/differential/video-lut.test.ts` | `matches native lut CLI rawvideo and framecrc through -vf and -filter_complex, with and without -ss/-t` | linear, graph |
| `filter.lut.stream` | `tests/differential/video-lut.test.ts` | `matches native replayed lut branches, joins and the multi-input CLI frame by frame` | graph, stream |
| `filter.lut.timed` | `tests/differential/video-lut.test.ts` | `matches native lut framecrc and rawvideo through the actor and timed schedulers` | actor, timed |
| `filter.lut.refusals` | `tests/differential/video-lut.test.ts` | `fails like native on unparsable and NaN expressions and refuses gammaval, unported functions, int overflow and timelines before any output` | linear, graph, actor, timed |
| `filter.lut.negotiation` | `tests/differential/video-lut.test.ts` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed |
| `filter.lut.syntax` | `tests/unit/video-lut.test.ts` | `refuses enable=, unknown options, gammaval, unported functions and ^ with named messages` | unit |

The contracts cover every platform. None is gated to linux-x64.

## Unsupported scope

- `gammaval()` and `gammaval709()`, which need PREP-EXPR.
- The unported libm builtins, `root`, `time` and `^`.
- Out-of-int-range values in used entries, and tables that differ between the profiles.
- The 9..16-bit YUV, gray and GBR(A) members, `rgb48le`/`rgba64le`, `gbrap`, `yuv411p`/`yuv410p`/`yuv440p`, `yuva422p`/`yuva444p` and `yuvj440p`, which have no frame storage here. Negotiation reaches yuvj444p and yuva444p only with lutyuv, and those picks are refused by name.
- `enable=` timelines and runtime commands.
