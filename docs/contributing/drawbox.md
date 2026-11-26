# Drawbox and drawgrid

`drawbox` draws a rectangle outline (or a filled box) and `drawgrid` draws a grid of lines on each
frame, as pinned FFmpeg `libavfilter/vf_drawbox.c` does. Both are `frame` operators
(`packages/avfilter/src/video-ops/drawbox.ts` and `drawgrid.ts`) sharing one kernel,
`packages/avfilter/src/video-drawbox.ts`. Provenance is in `packages/avfilter/NOTICE-DRAWBOX`.

## Syntax

- `drawbox=x:y:width:height:color:thickness:replace` (native shorthand order; `box_source` would be eighth).
- `drawgrid=x:y:width:height:color:thickness:replace`.
- Named options: `x`, `y`, `width`/`w`, `height`/`h`, `color`/`c`, `thickness`/`t`, `replace`. The last repeat wins.
- Defaults: `x=0`, `y=0`, `w=0`, `h=0` (0 or less means the input size), `color=black`, `replace=0`, and `t=3` for drawbox, `t=1` for drawgrid.

### Expressions

`x`, `y`, `w`, `h` and `t` are expressions, evaluated by the shared `evaluateExpression` the way
`config_input` does it:

- **Variables.** `dar`, `hsub`, `vsub`, `in_h`/`ih`, `in_w`/`iw`, `sar`, `x`, `y`, `h`, `w`, `t` and `fill` (native's `VAR_MAX`).
  `fill` is `iw` for x, `ih` for y, `iw - x` for w, `ih - y` for h and `INT_MAX` for t, so `t=fill` fills the box.
- **Evaluation.** Six passes over x, y, w, h, t in that order. The variables keep the doubles of the previous evaluation, and
  the geometry is their C `(int)` truncation. A NaN in the last pass fails with native's
  `Error when evaluating the expression '<expr>'.`, and so does a parse error (native status `256 - EINVAL`).
- **st/ld state.** Each evaluation starts with fresh `st`/`ld` slots, as `av_expr_parse_and_eval` does.
- **Numeric profiles.** The geometry is computed under both the `linux-x64` and `darwin-arm64` expression profiles. If they
  differ, the expression is refused as platform-dependent.
- **Allowed functions.** Arithmetic, comparisons, `abs`, `min`, `max`, `mod`, `if`, `ifnot`, `not`, `between`, `clip`,
  `isnan`, `isinf`, `floor`, `ceil`, `trunc`, `round`, `sqrt`, `gcd`, `sgn`, `bitand`, `bitor`, `st`, `ld`, and the ported `log` and `hypot`.

These expression forms are refused at parse time:

- calls to the JavaScript-libm functions (`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `exp`, `pow`, `gauss`, `squish`);
- calls to `random`, `randomi`, `time` and `print`;
- calls to `lerp` (its multiply-add can be contracted on macOS) and the iterative `while`, `taylor` and `root`;
- any read of `sar` or `dar`. The frame contract carries no sample aspect ratio, so its value cannot be known on every path.

These evaluation results are refused before output:

- a final value that is infinite or outside the `int` range, where the C conversion is undefined;
- an expression that reads `fill` while the preceding x or y conversion of that pass is undefined (NaN or out of range), or
  while `iw - x` or `ih - y` overflows `int`. Native's value then differs between x86-64 and arm64. A typical case is
  `y=ih-h:h=fill-1`, where `h` is still NaN in the first pass;
- drawbox geometry where `x + w` or `y + h` overflows `int`;
- drawgrid geometry where `-x`, `iw - 1 - x`, `-y` or `ih - 1 - y` overflows `int`.

### Colour

`color` is `invert` (case-sensitive; it inverts luma on YUV formats and R, G and B on packed RGB), or any
`av_parse_color` string through the shared `parseColor`, including names, `#`/`0x` hex and `@alpha`. Invalid
colours fail with native's message (native status `256 - EINVAL`). `random`, `bikeshed` and NaN or
platform-dependent alphas are refused as unsupported. YUV formats use the integer `RGB_TO_Y_CCIR`,
`RGB_TO_U_CCIR` and `RGB_TO_V_CCIR` macros. The colour alpha is the blend weight.

### Refused options

- `box_source`: any value. Native fails on values other than `side_data_detection_bboxes`, and with that value it reads
  detection side data that frames here do not carry.
- `enable=`, every other option, and runtime commands. The descriptors set neither `timeline` nor `geometryCommands`.

## Semantics

- **drawbox** visits `[max(x,0), min(x+w,iw))` × `[max(y,0), min(y+h,ih))`. A pixel is drawn when it lies
  within `t` of an edge (`pixel_belongs_to_box`). **drawgrid** visits the whole frame and draws where
  `(px - x) mod w < t` or `(py - y) mod h < t`, using C remainders corrected to non-negative values.
- **Planar YUV.** Chroma sample `(x >> hsub, y >> vsub)` is rewritten once for every covered luma sample, in native row and
  column order. Translucent colours therefore compound on subsampled chroma, as natively.
- **Blending.** Without `replace`, or on formats without alpha, YUV blends in double, `trunc((1 - a/255) * p + a/255 * c)`.
  Packed RGB blends in float, `trunc(f(f(f(1 - f(a/255)) * p) + f(f(a/255) * c)))` with `Math.fround`. The alpha plane or
  byte is left unchanged.
- **replace=1 on alpha formats** (`yuva420p`, `rgba`, `bgra`, `argb`, `abgr`). The colour and its alpha are written as
  integers. `replace` has no effect on formats without alpha.

## Formats

`formats()` returns native's `pix_fmts` in declared order:

`yuv444p yuv422p yuv420p yuv411p yuv410p yuvj444p yuvj422p yuvj420p yuv440p yuvj440p yuva420p yuva422p yuva444p rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0`

Frames run in the members with storage here:

- `yuv444p`, `yuv422p`, `yuv420p`, `yuva420p`, `rgb24`, `bgr24`, `rgba`, `bgra`, `argb` and `abgr`;
- the legacy `yuvj420p`, `yuvj422p` and `yuvj444p` sources on linear chains.

The shared negotiators refuse any other pick by name. The per-source negotiation test found that every one of the 17
accepted sources picks a stored format:

- `gray` and `gbrp` convert to `rgb24`;
- `nv12` and `nv21` convert to `yuv420p`;
- every other source passes through.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are flagged for both operators. The geometry is evaluated in `geometry()`
on the negotiated format and size, which refuses before output, and again in `frame()` (cached per format and size).

## Determinism and arithmetic profile

Opaque colours (alpha 255), alpha 0, `invert` and `replace=1` on alpha formats are integer on every platform, because the
blend of an alpha of exactly 0 or 1 is exact, fused or not. These cases run on every platform.

Translucent blends are a double (YUV) or float (packed RGB) multiply-add. GCC on x86-64 does not contract it, and clang on
macOS arm64 fuses it. Those cases are gated to linux-x64 in one test with a constant title. No macOS difference was
measured in this sandbox, so the gate is a precaution taken from the determinism notes.

The native reference runs with `-cpuflags 0`, and the timed backend uses the expression profile of the reference platform,
read from `build-metadata.json`.

## Evidence

`tests/differential/video-drawbox.test.ts` ran against the sandbox reference build (commit 946fcce0, `--disable-x86asm`,
Linux x86_64, ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). It finished in about 35 s on 4 vCPUs.

| Test | Cases |
|---|---|
| `runs against the reference build of the pinned commit without x86 assembly` | build-metadata commit and flags |
| `matches native linear drawbox and drawgrid bytes for integer colours across formats, sizes, crossing and outside boxes and patterns` | 1560 byte-identical rawvideo outputs: 10 stored formats x sizes 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 x 26 filters. Each output covers 3 frames: noise, ramps with an edge, and constant planes. The filters include boxes inside, crossing and outside the frame, `t=fill`, `t=0`/`-1`, odd thickness on subsampled chroma, iterated expressions, `st`/`ld`, `hypot`, `invert`, `replace=1` with translucent colours, alpha 0, and grids with positive and negative offsets. |
| `matches native translucent drawbox and drawgrid blending on linear chains and the CLI paths (linux-x64 unfused double and float)` | 360 linear outputs (10 formats x 6 sizes x 6 translucent filters), plus 640 CLI outputs (10 formats x 7x5 x 4 filters x rawvideo/framecrc x with/without `-ss 0.04`/`-t 0.05` x 4 executions) |
| `matches native drawbox and drawgrid rawvideo and framecrc through linear, graph, actor and timed CLI execution with and without -ss/-t` | 1920 byte-identical outputs: 10 formats x 7x5/17x9 x 6 filters x rawvideo/framecrc x 2 time scopes x (media `-vf`, media `-filter_complex`, timed `activation` actors, timed `pull` executor). Native output with default threads equals `-filter_threads 1` for every case. |
| `matches native replayed drawbox and drawgrid branches and joins frame by frame` | 40 `createReplayVideoExecution` graphs with split, hstack, nullsink, hflip and vflip |
| `refuses native errors with native status and the scoped-out forms native runs, before opening outputs on every path` | 17 filters, each checked against native's status, the linear plan and 4 CLI executions with no output opened (68). The 7 native errors (invalid colour, alpha or hex, bad `box_source`, NaN or undefined expressions) are checked at native status `256 - EINVAL`. The 10 forms native runs are also covered: `box_source=side_data_detection_bboxes`, `sin`, `pow`, `sar`, `random`, int overflow, the platform-dependent `fill`, `enable=` and `threads`. |
| `negotiates every accepted source as native does for drawbox and drawgrid and runs each pick on every path` | 2 filters x 17 sources; 73 checks each (146): every pick is stored and byte-exact on the five paths |

`tests/unit/video-drawbox.test.ts` (5 tests) covers:

- parsing and every refusal, the CCIR colours and the iterative geometry;
- double and float blends with compounding chroma, and `replace` and `invert`;
- padded input, an unmutated input and owned output planes;
- `maxFrameBytes`, malformed strides, time bases and `AbortSignal`;
- planning on each path.

## Proposed contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| `filter.drawbox.linear` | `tests/differential/video-drawbox.test.ts` | `matches native linear drawbox and drawgrid bytes for integer colours across formats, sizes, crossing and outside boxes and patterns` | linear rawvideo, integer colours, 10 formats, 6 sizes | all |
| `filter.drawbox.translucent` | `tests/differential/video-drawbox.test.ts` | `matches native translucent drawbox and drawgrid blending on linear chains and the CLI paths (linux-x64 unfused double and float)` | translucent blends on linear, graph, actor and timed | `["linux-x64"]` |
| `filter.drawbox.cli` | `tests/differential/video-drawbox.test.ts` | `matches native drawbox and drawgrid rawvideo and framecrc through linear, graph, actor and timed CLI execution with and without -ss/-t` | CLI rawvideo/framecrc, -ss/-t, threads agreement | all |
| `filter.drawbox.stream` | `tests/differential/video-drawbox.test.ts` | `matches native replayed drawbox and drawgrid branches and joins frame by frame` | replay streams with split/stack | all |
| `filter.drawbox.refusals` | `tests/differential/video-drawbox.test.ts` | `refuses native errors with native status and the scoped-out forms native runs, before opening outputs on every path` | refusals before output | all |
| `filter.drawbox.negotiation` | `tests/differential/video-drawbox.test.ts` | `negotiates every accepted source as native does for drawbox and drawgrid and runs each pick on every path` | per-source negotiation on five paths | all |

## Unsupported

The following are refused explicitly before output:

- `box_source`;
- expressions reading `sar` or `dar`;
- calls to unported, random, clock, print or iterative functions;
- results outside the `int` range or with platform-dependent conversions;
- `random` colours and NaN alphas;
- `enable=` and runtime commands;
- every format without storage here.

EdgeFFmpeg exits with status 1 for the native `EINVAL` errors, because the CLI does not map filter configuration errors to
errno statuses, which are owned elsewhere. Only the refusal itself and the absence of output are compared.
