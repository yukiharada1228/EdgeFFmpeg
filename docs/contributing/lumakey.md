# lumakey video filter

`lumakey` turns a luma range into transparency: it rewrites the alpha plane from the luma plane and copies Y, U and V. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_lumakey.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-LUMAKEY`; the descriptor is `packages/avfilter/src/video-ops/lumakey.ts`.

## Syntax

`lumakey[=threshold:tolerance:softness]`, or the named options in any order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `threshold` | `AV_OPT_TYPE_DOUBLE` | 0..1 | 0 |
| `tolerance` | `AV_OPT_TYPE_DOUBLE` | 0..1 | 0.01 |
| `softness` | `AV_OPT_TYPE_DOUBLE` | 0..1 | 0 |

Values must be constant decimals (`0.5`, `.25`, `1.`, `5e-1`, an optional sign). `av_strtod` reads them exactly as `Number` does. A value outside 0..1 fails with `Invalid lumakey <option>: must be between 0 and 1`, as native's range check fails, while parsing and before any output is opened.

## Semantics

`config_input` for depth 8, computed once per step:

- `white = av_clip_uint8((threshold + tolerance) * 255)`, `black = av_clip_uint8((threshold - tolerance) * 255)`: the double is truncated to `int`, then clipped to 0..255.
- `so = (int)(softness * 255)`.

Per pixel, as `do_lumakey_slice8` does, with `l` the luma sample at the same position:

- `black <= l <= white`: alpha is 0.
- otherwise, `black - so < l < white + so`: alpha is `255 - (l - black + so) * 255 / so` below `black` and `(l - white) * 255 / so` above `white`, with C integer division.
- otherwise the input alpha is kept.

With `softness=0` the second branch can never be taken, so there is no division by zero. Native keys in place on a writable frame; here the result is written to owned tight planes and the input frame is not changed.

## Formats

`formats()` returns native `pixel_fmts` in declared order: yuva444p, yuva422p, yuva420p and their 9, 10, 12 and 16 bit forms (14 formats). The shared negotiators therefore pick what native picks. Only `yuva420p` has frame storage here. The negotiators refuse every other pick at plan time with `Video filter lumakey input negotiates <format>, which is not implemented`, on every path and before any output is opened.

Native picks, measured by the per-source negotiation test:

| Source | Native pick | Here |
|---|---|---|
| yuv420p, nv12, nv21, yuva420p, yuvj420p (linear chains) | yuva420p | runs byte-exact (yuv420p gets opaque alpha from the conversion) |
| yuv422p, yuvj422p | yuva422p | refused by name |
| yuv444p, yuvj444p, gray, rgb24, bgr24, gbrp, rgba, bgra, argb, abgr | yuva444p | refused by name |

The registry examples run from an 8x8 gray source, which would pick yuva444p, so each example starts with `format=yuva420p`.

## Refused forms

- `enable=`: `Lumakey timeline expressions are not implemented`. Native supports the generic timeline.
- Runtime commands (`threshold`, `tolerance`, `softness`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them.
- Expressions and other non-decimal values (`1/2`, `0x1`, constants): `Only constant decimal lumakey <option> values are implemented`. Native evaluates them.
- Any other option, such as `threads`: `Unsupported lumakey option`.
- Frames in a format other than yuva420p, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with explicit errors. `AbortSignal` is checked before work and on every row.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function.

## Determinism

Each bound is one double add or subtract followed by one multiply by 255 (`(a + b) * c`, which cannot be contracted to a fused multiply-add), then truncation. `so` is one multiply. All inputs lie in 0..1, so every value is exactly representable in the range the conversion needs and the result is the same on every IEEE-754 platform. Everything after that is integer arithmetic. No case is platform-gated. Native slices are independent row ranges; the frame test checks that the default thread count and `-filter_threads 1` give the same bytes.

## Evidence

`tests/differential/video-lumakey.test.ts` runs `.build/reference/ffmpeg` at test time, after asserting from `.build/reference/build-metadata.json` that it is commit `946fcce0` built with `--disable-x86asm`. It ran on linux x64 in the wave 2 sandbox, with ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. This is an unpinned sandbox build, not the pinned linux-x64 reference. Inputs combine gradients and stripes with LCG noise, constant planes, and 16x16 luma ramps that cover every 8-bit value (ascending, descending and permuted).

| Test title | Path | Comparisons |
|---|---|---|
| `runs against the reference build of commit 946fcce0 with x86 assembly disabled` | – | build metadata check |
| `matches native lumakey frames for every option case, size and luma ramp, with default and single filter threads` | linear (`compileVideoFilterChain`) | 11 option cases x (6 sizes x {pattern, constant} + the ramp frame), 3 frames each: 143 byte matches against native, and 143 native default-thread vs `-filter_threads 1` agreements |
| `matches native -vf lumakey rawvideo and framecrc from yuva420p and yuv420p sources with and without time scopes` | linear CLI `-vf` | 2 sources x 6 sizes x 4 chains x {rawvideo, framecrc} x {none, `-ss 0.04` / `-t 0.05`}: 192 |
| `matches native -filter_complex lumakey split branches on the graph path and the timed backend` | graph (media `-filter_complex`), actor (timed `producer`) | 2 sources x 3 sizes x 2 graphs x 2 muxers x {none, `-ss`/`-frames:v`} x 2 backends: 96 runs, two outputs each |
| `matches native lumakey on the stream path through replay execution, activation actors and the multi-input CLI` | stream, actor | 36 `createReplayVideoExecution` cases, 24 `createFrameActors` cases and 2 multi-input CLI cases: 62 |
| `matches native lumakey through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer`), timed (`pull`) | 3 sources x 2 chains x 2 muxers x 2 schedulers x 2 time scopes: 48 |
| `fails like native for out-of-range lumakey options and refuses timeline and unscoped options before opening any output` | linear, graph, actor, timed | 3 out-of-range options x 4 CLI backends: 12 native-failure parities with no output file on either side; plus 6 scope refusals (`enable=`, `threads`, expressions) with no output opened |
| `negotiates every accepted source as native does and refuses the yuva422p and yuva444p picks without storage before output` | linear, graph, stream, actor, timed, CLI | `lumakey=0.5:0.2:0.1` from 17 sources, with native's pick read from showinfo. 5 run byte-exact on the five paths (yuvj420p on linear chains only). 12 are refused by name on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs, with no output opened. 113 checks |

Three mutations were each caught by this file: `254 -` for `255 -` below black (6 tests failed), rounding instead of truncating `so` (5 failed), and an exclusive upper key bound (3 failed).

`tests/unit/video-lumakey.test.ts` covers parsing, ranges and messages, the bounds, keying above and below the key range, unmutated padded input and owned output planes, refused formats, budgets, malformed strides and plane counts, invalid settings, `AbortSignal`, the plan-time refusal of yuva444p picks, and refused runtime commands.

## Proposed test contracts

All run on every platform (no gate).

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.lumakey.frames` | `tests/differential/video-lumakey.test.ts` | `matches native lumakey frames for every option case, size and luma ramp, with default and single filter threads` | yuva420p, every option class, every 8-bit luma value, six sizes, thread-count independence |
| `filter.lumakey.cli` | `tests/differential/video-lumakey.test.ts` | `matches native -vf lumakey rawvideo and framecrc from yuva420p and yuv420p sources with and without time scopes` | `-vf` rawvideo and framecrc, yuv420p conversion, `-ss`/`-t` |
| `filter.lumakey.graph` | `tests/differential/video-lumakey.test.ts` | `matches native -filter_complex lumakey split branches on the graph path and the timed backend` | `-filter_complex` two outputs, media and timed backends |
| `filter.lumakey.stream` | `tests/differential/video-lumakey.test.ts` | `matches native lumakey on the stream path through replay execution, activation actors and the multi-input CLI` | replay streams, actors and the multi-input CLI |
| `filter.lumakey.timed` | `tests/differential/video-lumakey.test.ts` | `matches native lumakey through the timed backend on the actor and timed paths in rawvideo and framecrc` | timed backend `producer` and `pull` schedulers |
| `filter.lumakey.reject` | `tests/differential/video-lumakey.test.ts` | `fails like native for out-of-range lumakey options and refuses timeline and unscoped options before opening any output` | option range parity, scope refusals, no output opened |
| `filter.lumakey.negotiation` | `tests/differential/video-lumakey.test.ts` | `negotiates every accepted source as native does and refuses the yuva422p and yuva444p picks without storage before output` | native picks from 17 sources; yuva422p/yuva444p refused by name on every path |

## Unsupported scope

- yuva422p, yuva444p and every high-depth alpha format: no frame storage here, so they are refused by name. Native picks them for every source that is not 4:2:0, gray and RGB included.
- `enable=` timelines and runtime commands.
- Option expressions and constants.
