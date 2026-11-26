# despill video filter

`despill` follows pinned `libavfilter/vf_despill.c` (FFmpeg 9.0.2,
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor, the parser
`parseDespillOptions` and the kernel `despillVideoFrame` are in
`packages/avfilter/src/video-ops/despill.ts`. Provenance is in
`packages/avfilter/NOTICE-DESPILL`.

## Syntax

The shorthand follows AVOption order: `type`, `mix`, `expand`, `red`, `green`, `blue`,
`brightness`, `alpha`. The `green`/`blue` type constants are not positions. Repeated keys
keep the last value.

| Option | Type | Range | Default | Accepted forms |
|---|---|---|---|---|
| `type` | INT with constants | 0..1 | 0 (`green`) | `green`, `blue`, and integer expressions through the shared `filterIntegerOption` (`1`, `max`, `0.4` rounds to 0) |
| `mix` | FLOAT | 0..1 | 0.5 | plain decimals (`0.3`, `.5`, `1e0`), range-checked as a double, stored as `Math.fround` |
| `expand` | FLOAT | 0..1 | 0 | as `mix` |
| `red`, `green`, `blue` | FLOAT | -100..100 | 0, -1, 0 | as `mix` |
| `brightness` | FLOAT | -10..10 | 0 | as `mix` |
| `alpha` | BOOL | 0..1 | 0 | `true y yes enable enabled on`, `false n no disable disabled off` (any case), or integers 0 and 1 |

`despill=green` sets `type`, while `despill=green=2` sets the green scale. Native reads
`green=green` as a float expression and fails; we refuse it as well.

### Refused forms

These are refused at parse time on every path, before any input is read or output opened:

- Out-of-range values (`mix=1.5`, `red=101`, `brightness=-11`, `type=2`, `alpha=2`) and
  `alpha=auto`. Native rejects all of them too.
- Float values that are expressions or carry SI suffixes (`mix=0.25+0.25`, `red=0.01k`).
  Native evaluates these. We fail with `Only decimal despill <key> values are implemented`.
- `enable=`. The native filter supports the generic timeline. We fail with
  `Despill timeline expressions are not implemented`.
- Any other option, such as `threads`: `Unsupported despill option`.
- Runtime commands (`type`, `mix`, …, `enable`). Native has `process_command`. The descriptor
  sets neither `timeline` nor `geometryCommands`, so the activation actors answer these
  commands with the unsupported code.

## Formats

`formats()` returns the native `pixel_fmts` list in declared order: `argb`, `rgba`, `abgr`,
`bgra`. All four have packed frame storage, so no pick is refused. The per-source negotiation
test pins native's picks:

- The packed-alpha sources pass through unchanged.
- Every other source (yuv, nv12/nv21, rgb24/bgr24, gray, gbrp, yuva420p, yuvj) converts to
  `argb`.

The kernel copies each row into an owned tight plane and then applies the filter to the copy,
as native does with its writable frame. When `alpha=0` the alpha byte is copied unchanged.
PTS and metadata are copied.

## Arithmetic and determinism

The kernel is a port of `do_despill_slice` in float.

- Every float operation is wrapped in `Math.fround`, in C evaluation order. There is no
  contraction: `red*mix + green*factor` is two rounded products followed by a rounded sum, and
  `red + spillmap*redscale + brightness*spillmap` is evaluated left to right.
- `FFMAX(x, 0.f)` maps -0 to +0.
- `av_clip_uint8(v*255)` truncates the rounded float toward zero, as the C float-to-int
  conversion does, and then clips.
- No libm function is used.

The reference x86-64 build (`--disable-x86asm`, gcc 13 with no FMA target) does not fuse
operations. macOS arm64 contracts multiply-adds. Following the wave rule, every case whose
products are inexact is gated to `linux-x64`.

Cases where every multiplier is 0 or a power of two run on every platform. For those cases
each product is exact, so fused and unfused arithmetic give the same result. This holds for
`mix` and `expand` in {0, 0.5, 1}, which makes `factor` one of {0, 0.25, 0.5, 1}, and for the
scales and `brightness` in {0, ±0.5, ±1, ±2, ±4, ±8}. The defaults are among these cases.

A simulation in this sandbox checked the gate. A JS model of the contracted expressions
(`fma(b,factor,red*mix)`, `fma(brightness,spillmap,fma(spillmap,scale,c))`) was run over a
256x256x86 RGB grid:

- The 11 portable option sets changed 0 pixels.
- Six of the 9 gated sets changed between 317 and 54024 pixels.

No macOS run was made, so the gate is a precaution backed by this simulation, not a measured
macOS difference.

Native slice threading partitions rows, and every pixel is independent of the others. The
kernel processes the whole frame. Native output is identical with default threads,
`-filter_threads 1` and `-filter_threads 8`; this was checked on 17x9 and 64x48 frames.

## Paths

All five paths are flagged: `linear`, `graph`, `stream`, `actor` and `timed`. Despill is a
stateless `frame` operator, so `actor` and `timed` call `frame` directly. The registry
examples start with `format=<packed>` from the 8x8 gray source.

## Evidence

`tests/differential/video-despill.test.ts` runs `.build/reference/ffmpeg` at test time. It
first asserts from `build-metadata.json` that the build is commit 946fcce0 with
`--disable-x86asm`. It uses generated frames only and commits no native output.

The frames used in the despill-specific cases come in three kinds:

- byte noise;
- structured colour ramps (red, green and blue ramps, spill-like greens);
- edges and constant planes (keyed greens and blues, white, black, gray, primaries, alpha 0,
  1, 254 and 255).

Sizes are 1x1, 2x2, 5x3, 7x5, 8x6 and 17x9, with 3 frames each.

| Test title | Platforms | Comparisons |
|---|---|---|
| `checks the native reference build at test time` | all | commit and `--disable-x86asm` |
| `matches native despill pixels on every packed order, size and pattern with contraction-free options` | all | 4 formats x 6 sizes x 11 option sets x 3 frames: 792 frame byte matches (726 frames changed by the filter) |
| `matches native despill pixels at typical and extreme float option values on every packed order and size (linux/x64)` | linux-x64 | 4 x 6 x 9 option sets (including every range extreme) x 3: 648 frame byte matches (615 changed) |
| `agrees with native slice threading: default threads and -filter_threads 1 give the same bytes as the kernel` | all | 4 formats x {17x9, 64x48} x 2 option sets: 16 kernel matches, 32 native-native matches |
| `matches native despill linear and graph plans with scalar conversions around the packed stage` | all | 5 sources (rgba, abgr, rgb24, gray, yuv420p) x 2 sizes x 5 chains x 4 output formats, linear and graph: 400 |
| `matches native replayed despill streams and activation actors with branches and joins frame by frame` | all | 16 replay streams (split, hstack, nullsink) and 12 `createFrameActors` runs |
| `matches native despill CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths` | all | 4 formats x 4 chains x {rawvideo, framecrc} x {none, `-ss 0.04 -t 0.05`} x media `-vf`/`-filter_complex`, timed `producer`, `activation` and `pull`: 304 |
| `refuses despill options before any output is opened where native rejects or would evaluate them` | all | 18 option forms: native status pinned (13 fail natively, 5 natively accepted), each refused on 4 backends with no output opened: 72 |
| `negotiates every accepted source as native does with contraction-free defaults` | all | 17 sources, native pick from showinfo, byte-exact on the five paths (yuvj on linear only): 73 |

That is 2333 comparisons against native in total: 1685 everywhere and 648 on linux-x64 only.
Every comparison passed in this sandbox (linux x64).

Two mutations of the kernel were each caught by this file:

- an unrounded spill-map sum: 7 tests failed;
- rounding instead of truncation on output: 6 tests failed.

`tests/unit/video-despill.test.ts` (5 tests) covers:

- parsing: defaults, shorthand, the `green` constant/option overlap, float storage, the bool
  names, ranges and every refusal message;
- the native list order and the descriptor flags;
- pixel values read from native, on every packed component order;
- an unmutated padded input and an owned tight output;
- `maxFrameBytes`, malformed strides and plane counts, invalid settings, unsupported formats
  and `AbortSignal`;
- the linear, graph and actor planners, `enable=`, and refused runtime commands.

Sandbox reference: `.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built by
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` on linux x64 (Node 24.22.3).

## Unsupported scope

- Expression-valued and suffixed float options.
- `enable=` timelines and runtime commands.
- Fused-arithmetic parity: the general float cases are pinned to linux-x64.

## Proposed test contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| `filter.despill.build` | `tests/differential/video-despill.test.ts` | `checks the native reference build at test time` | reference commit and flags | all |
| `filter.despill.kernel` | `tests/differential/video-despill.test.ts` | `matches native despill pixels on every packed order, size and pattern with contraction-free options` | defaults and exact-product options, 4 packed orders, 6 sizes | all |
| `filter.despill.float` | `tests/differential/video-despill.test.ts` | `matches native despill pixels at typical and extreme float option values on every packed order and size (linux/x64)` | typical values and range extremes | linux-x64 |
| `filter.despill.threads` | `tests/differential/video-despill.test.ts` | `agrees with native slice threading: default threads and -filter_threads 1 give the same bytes as the kernel` | slice-thread invariance | all |
| `filter.despill.linear` | `tests/differential/video-despill.test.ts` | `matches native despill linear and graph plans with scalar conversions around the packed stage` | linear and graph plans with conversions | all |
| `filter.despill.stream` | `tests/differential/video-despill.test.ts` | `matches native replayed despill streams and activation actors with branches and joins frame by frame` | stream and actor paths | all |
| `filter.despill.cli` | `tests/differential/video-despill.test.ts` | `matches native despill CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths` | CLI on every backend and scheduler, rawvideo and framecrc, -ss/-t | all |
| `filter.despill.reject` | `tests/differential/video-despill.test.ts` | `refuses despill options before any output is opened where native rejects or would evaluate them` | refusal parity before output | all |
| `filter.despill.negotiation` | `tests/differential/video-despill.test.ts` | `negotiates every accepted source as native does with contraction-free defaults` | native picks from 17 sources | all |
