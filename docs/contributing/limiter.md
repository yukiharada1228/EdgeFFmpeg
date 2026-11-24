# limiter video filter

`limiter` clamps every sample of the selected planes to `[min, max]`. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_limiter.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-LIMITER`; the descriptor is `packages/avfilter/src/video-ops/limiter.ts`.

## Syntax

`limiter[=min:max:planes]`, or the named options `min`, `max` and `planes`, in any order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `min` | `AV_OPT_TYPE_INT` | 0..65535 | 0 |
| `max` | `AV_OPT_TYPE_INT` | 0..65535 | 65535 |
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |

The values are parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, hexadecimal input, the `default`, `min`, `max`, `none` and `all` constants, and rounds half to even. A value outside its range fails with `Invalid limiter <option>: ...`.

As in native `init`, the filter fails with `Limiter min must not exceed max` when `min > max` after every option has been applied. The comparison uses the unclamped values, so `limiter=256:255` fails. The failure happens while parsing, before any negotiation, input read or output open, on every path.

At configuration time each bound is clamped to `(1 << depth) - 1`. All six supported layouts have depth 8, so both bounds clamp to 255: `limiter=300` sets every selected sample to 255. A plane whose bit is not set in `planes` is copied unchanged. Bits without a plane (bit 3 for three-plane formats, bits 1 to 3 for gray) are ignored. For gbrp the bits follow the plane index, G=1, B=2, R=4.

## Formats

The native `pix_fmts` list, restricted to its eight-bit members that are in the negotiation table, in table order: `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p`, `gbrp`. Other inputs are converted by the negotiator, as natively. The native and EdgeFFmpeg choices agree for nv12, nv21 (yuv420p), rgb24 and bgr24 (gbrp).

## Refused forms

- `enable=`: `Limiter timeline expressions are not implemented`. The native filter supports the generic timeline.
- Runtime commands (`min`, `max`, `planes`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them.
- Any other option, such as `threads`: `Unsupported limiter option`.
- Frames in a format other than the six above, malformed planes or strides, budgets over `maxFrameBytes`, and invalid time bases fail with explicit errors. `AbortSignal` is checked before work and on every row.

## Unsupported scope

- **Packed RGB with alpha.** For rgba, bgra, argb and abgr input, native negotiates `gbrap`, which the shared negotiation table does not contain. EdgeFFmpeg negotiates `yuva420p`, so the output differs from native. The descriptor cannot see the pre-conversion format, so this cannot be refused inside the module. Fixing it needs `gbrap` in `packages/avfilter/src/video-ops/formats.ts` and pixel-layout support, which are shared edits outside this task. Use explicit eight-bit planar input in the meantime.
- High-bit-depth formats (9 to 16 bit), `yuv440p`, `yuv411p`, `yuv410p`, `yuvj*`, `yuva422p`, `yuva444p` and `gbrap`. They are not in the negotiation table.
- `enable=` timelines and runtime commands.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry test checks that the examples give the same output on every path.

## Determinism

Integer clipping only, with no rounding or arithmetic profile. The Linux reference is built with x86 assembly disabled, so native runs the C `limiter8` path. The output does not depend on the thread count, because native slices are independent row ranges.

## Evidence

`tests/differential/video-limiter.test.ts` runs `.build/reference/ffmpeg` at test time. Its inputs combine ramps and 0/255 extremes with LCG noise:

| Test title | Path | Comparisons |
|---|---|---|
| `matches native linear limiter bounds, plane masks and min > max refusals across every declared format` | linear (`compileVideoFilterChain`) | 6 formats x {5x3, 6x4} x 10 min/max pairs (defaults, 16:235, 0:0, 255:255, 128:128, 300:400, 100:300, 65535:65535, and the native errors 200:100 and 256:255) x planes {0,1,2,5,8,15}: 576 two-frame rawvideo byte matches and 144 native-error matches |
| `matches native limiter CLI rawvideo and framecrc on the linear path, including implicit conversions` | linear CLI `-vf` | 8 sources (the six formats, plus nv12 and rgb24 through conversion with `-cpuflags 0`) x 5 chains x {rawvideo, framecrc}: 80 |
| `matches native limiter filter_complex branches on the graph path in rawvideo and framecrc` | graph CLI `-filter_complex` | 4 sources x 2 graphs x 2 muxers, with two outputs each: 16 cases, 32 files |
| `matches native limiter on the stream path through replay execution and the multi-input CLI` | stream | 6 `createReplayVideoExecution` rawvideo cases and 2 multi-input CLI cases (rawvideo and framecrc): 8 |
| `matches native limiter through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer` scheduler), timed (`pull` scheduler) | 3 sources x 2 chains x 2 muxers x 2 schedulers: 24 |
| `fails like native for limiter min > max before opening any output on every path` | linear, graph, stream, actor, timed | 6 rejections: native exits non-zero with no output file, and EdgeFFmpeg exits non-zero without opening an output |

Two mutations were each caught by this file: dropping the 255 clamp of `min` (4 tests failed) and ignoring the plane mask (5 tests failed).

`tests/unit/video-limiter.test.ts` covers parsing, ranges and messages, the min > max refusal on the linear, graph and actor parsers, `enable=`, refused runtime commands, budgets, malformed strides and plane counts, invalid settings, `AbortSignal`, and an unmutated padded input.

## Proposed test contracts

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.limiter.linear` | `tests/differential/video-limiter.test.ts` | `matches native linear limiter bounds, plane masks and min > max refusals across every declared format` | the six eight-bit formats, every min/max class, the plane masks, odd and even sizes |
| `filter.limiter.cli` | `tests/differential/video-limiter.test.ts` | `matches native limiter CLI rawvideo and framecrc on the linear path, including implicit conversions` | `-vf` rawvideo and framecrc, including nv12 and rgb24 conversions |
| `filter.limiter.graph` | `tests/differential/video-limiter.test.ts` | `matches native limiter filter_complex branches on the graph path in rawvideo and framecrc` | `-filter_complex` with two outputs |
| `filter.limiter.stream` | `tests/differential/video-limiter.test.ts` | `matches native limiter on the stream path through replay execution and the multi-input CLI` | replay streams and the multi-input CLI |
| `filter.limiter.timed` | `tests/differential/video-limiter.test.ts` | `matches native limiter through the timed backend on the actor and timed paths in rawvideo and framecrc` | the timed backend's `producer` and `pull` schedulers |
| `filter.limiter.reject` | `tests/differential/video-limiter.test.ts` | `fails like native for limiter min > max before opening any output on every path` | init refusal parity, with no output opened |
