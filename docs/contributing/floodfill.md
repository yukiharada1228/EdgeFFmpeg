# floodfill video filter

`floodfill` replaces the 4-connected region around a seed pixel whose components all equal `s0..s3` with `d0..d3`. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_floodfill.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-FLOODFILL`; the descriptor is `packages/avfilter/src/video-ops/floodfill.ts`.

## Syntax

`floodfill[=x:y:s0:s1:s2:s3:d0:d1:d2:d3]`, or the named options in any order. The shorthand follows the native option table order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `x`, `y` | `AV_OPT_TYPE_INT` seed coordinate | 0..65535 | 0 |
| `s0`..`s3` | `AV_OPT_TYPE_INT` source component | -1..65535 | 0 |
| `d0`..`d3` | `AV_OPT_TYPE_INT` destination component | 0..65535 | 0 |

The values are parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, hexadecimal input, the `default`, `min`, `max`, `none` and `all` constants, and rounds half to even. A value outside its range fails with `Invalid floodfill <option>: ...`, while parsing and before any negotiation, input read or output open, on every path. Native fails these the same way (`out of range`), before it creates an output file.

## Semantics

Per frame, as native `filter_frame` does:

1. A seed outside the frame (`x >= width` or `y >= height`) passes the frame through unchanged.
2. A source of `-1` is replaced by the seed's value on that plane (`pick_pixel`), only for the planes the format has.
3. If the sources equal the destinations on every plane of the format, the frame passes through.
4. If the seed does not match the sources on every plane, the frame passes through. A source above 255 never matches an eight-bit sample.
5. Otherwise the 4-connected region of pixels matching on every plane becomes `d0..d3`. Eight-bit `set_pixel` stores each destination modulo 256 (`d0=300` writes 44). Components beyond the format's plane count are ignored (`s1..s3` and `d1..d3` on gray, `s3`/`d3` on yuv444p and gbrp). gbrp components follow plane order: G, B, R.

The point stack pops in native order. Pushes of neighbours that do not match are skipped: a pixel that does not match never matches later (pixels only change to the destination, which does not match), so popping it would do nothing, and the sequence of `set_pixel` calls is unchanged. The stack holds four-byte pixel indices and grows up to `maxFrameBytes`; a fill that needs more fails with `Floodfill point stack exceeds allocation limit`. Frames wider or taller than 65536 are refused in `geometry` and again in `frame`, as native `filter_frame` refuses them (its points are `uint16`).

The filter keeps no state between frames.

### The never-terminating fill

When the destination stored modulo 256 still equals the sources on every plane but the unreduced destination differs (for example `floodfill=d0=256` over a 0 seed, or `d0=263:d1=263:d2=263` over a (7,7,7) seed), native rewrites each pixel with its own value. A lone matching seed (no matching 4-neighbour) then finishes with the frame unchanged, and EdgeFFmpeg does the same. Any larger region makes native re-push the same pixels forever: it overruns its point buffer and crashes (exit status 139), or spins until killed. EdgeFFmpeg does not mirror that out-of-bounds write and refuses the frame with `Floodfill destination matches its source after eight-bit truncation; native never terminates`. The condition depends on pixel values, so the refusal happens per frame, after the output has been opened, where native also fails.

## Formats

`formats()` is the native `pixel_fmts` list in declared order (25 formats: gray, yuv444p, yuva444p, gbrp and gbrap at 8 to 16 bits; there is no gray12), so the shared negotiators pick exactly what native picks. Frames run here in the three eight-bit layouts with frame storage: `gray`, `yuv444p` and `gbrp`. Other inputs get native's automatic conversion (measured from 17 sources by the negotiation test): yuv420p, yuv422p, nv12, nv21 and the legacy yuvj420p/yuvj422p/yuvj444p sources to yuv444p, and rgb24 and bgr24 to gbrp.

yuva420p converts to `yuva444p` natively and packed RGB with alpha (rgba, bgra, argb, abgr) to `gbrap`. Neither has frame storage here, so the negotiators refuse them at plan time with `Video filter floodfill input negotiates yuva444p, which is not implemented` (or `gbrap`), on every path and before any output is opened.

## Refused forms

- `enable=`: `Floodfill timeline expressions are not implemented`. Native supports the generic timeline.
- Runtime commands: the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native has no `process_command` either, and refuses them.
- Any other option, such as `threads`: `Unsupported floodfill option`.
- The never-terminating fill (see above).
- Frames in a format other than the three above, malformed planes or strides, budgets over `maxFrameBytes`, frames over 65536 in either dimension, and invalid time bases fail with explicit errors. `AbortSignal` is checked before work, on every copied row and every 16384 stack pops.

## Unsupported scope

- **yuva420p and packed RGB with alpha.** They negotiate yuva444p and gbrap natively and are refused before output (see Formats).
- High-bit-depth formats (9 to 16 bits), `yuva444p` and `gbrap` have no frame storage here; any negotiation that picks one is refused by name.
- `enable=` timelines and runtime commands.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry test runs the descriptor's six examples on every path and checks that they give the same output.

## Determinism

Integer compares and stores only, with no rounding and no arithmetic profile. Native runs the C path (there is no assembly for this filter), with no slice threading. Every case runs on every platform; no case is Linux-gated. Implicit conversions in the CLI and negotiation tests run native with `-cpuflags 0` and EdgeFFmpeg with scalar arithmetic. How native fails on the never-terminating fill (a crash or a spin) depends on its heap layout, so the tests pin only that it fails.

## Evidence

`tests/differential/video-floodfill.test.ts` runs `.build/reference/ffmpeg` at test time. Each test reads `.build/reference/build-metadata.json` and asserts commit `946fcce0` and `--disable-x86asm`; no binary digest is pinned. It ran in the wave 2 sandbox against a local build of the pinned commit (linux x64, ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node 24.22.3). The file takes about 13 seconds with `--maxWorkers=1`. Inputs are 2x2 checker blocks (diagonal-only contact between equal blocks), concentric rings (regions with holes), constant planes, two-value noise (many components), full LCG noise and ramps; on multi-plane formats about one sample in five of the later planes is flipped, so plane matching matters.

| Test title | Path | Comparisons |
|---|---|---|
| `matches native linear floodfill seeds, regions and pass-through cases across every executable format, size and pattern` | linear (`compileVideoFilterChain`) | {gray, yuv444p, gbrp} x {1x1, 2x2, 5x3, 7x5, 8x6, 17x9} x 6 patterns x 12 option sets (seeds at the origin, the far corner, the centre and an edge; picked and fixed sources; truncated destinations; seeds outside the frame in x, in y and at 65535; the S == d default; a non-matching fixed source; and two never-terminating destinations), 3 frames each: 1261 rawvideo byte matches and 35 cases where native fails (in one sandbox run 2 of them spun until SIGKILLed after 2 s and the rest crashed) and EdgeFFmpeg refuses |
| `matches native floodfill CLI rawvideo and framecrc on the linear path with seeking, including implicit conversions` | linear CLI `-vf` | 7 sources (gray, yuv444p, gbrp, and rgb24, bgr24, yuv420p and nv12 through conversion) at 5x3 to 17x9 x 3 chains x {rawvideo, framecrc} x {no seek, input `-ss` with output `-t`, output `-ss` with `-frames:v 1`}: 126 |
| `matches native floodfill filter_complex branches on the graph path in rawvideo and framecrc` | graph CLI `-filter_complex` | 4 sources x 2 graphs x 2 muxers, with two outputs each: 16 cases, 32 files |
| `matches native floodfill on the stream path through replay execution and the multi-input CLI` | stream | 6 `createReplayVideoExecution` rawvideo cases and 2 multi-input CLI cases (rawvideo and framecrc): 8 |
| `matches native floodfill through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer` scheduler), timed (`pull` scheduler) | 3 sources x 2 chains x 2 muxers x 2 schedulers: 24 |
| `fails like native for out-of-range floodfill options before opening any output on every path` | linear, graph, stream, actor, timed | 6 rejections: native exits non-zero (`out of range`) with no output file, and EdgeFFmpeg exits non-zero without opening an output |
| `negotiates every accepted source as native does and refuses the yuva444p and gbrap picks before output on every path` | linear, graph, stream, actor, timed, CLI | the per-source negotiation helper from 17 sources: 12 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains); yuva420p (yuva444p) and argb, rgba, abgr, bgra (gbrap) are refused by name on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened. 93 checks |

Two mutations were each caught by this file: dropping the left-neighbour push (5 of 7 tests failed) and comparing only the first plane (5 of 7 tests failed).

`tests/unit/video-floodfill.test.ts` (4 tests) covers parsing, the shorthand order, expressions, constants, ranges and messages, the declared format list, region fills with holes and diagonal-only contact, every pass-through case, modulo-256 stores, the lone-seed and never-terminating truncation cases, the point stack bound, the 65536 size refusal in `geometry` and `frame`, `enable=`, refused runtime commands, budgets, malformed strides and plane counts, invalid settings, `AbortSignal`, owned output planes and an unmutated padded input.

## Proposed test contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| `filter.floodfill.linear` | `tests/differential/video-floodfill.test.ts` | `matches native linear floodfill seeds, regions and pass-through cases across every executable format, size and pattern` | the three eight-bit formats, six sizes, six patterns, every seed and source class, and the never-terminating refusal | all |
| `filter.floodfill.cli` | `tests/differential/video-floodfill.test.ts` | `matches native floodfill CLI rawvideo and framecrc on the linear path with seeking, including implicit conversions` | `-vf` rawvideo and framecrc with and without `-ss`/`-t`, including conversions | all |
| `filter.floodfill.graph` | `tests/differential/video-floodfill.test.ts` | `matches native floodfill filter_complex branches on the graph path in rawvideo and framecrc` | `-filter_complex` with two outputs | all |
| `filter.floodfill.stream` | `tests/differential/video-floodfill.test.ts` | `matches native floodfill on the stream path through replay execution and the multi-input CLI` | replay streams and the multi-input CLI | all |
| `filter.floodfill.timed` | `tests/differential/video-floodfill.test.ts` | `matches native floodfill through the timed backend on the actor and timed paths in rawvideo and framecrc` | the timed backend's `producer` and `pull` schedulers | all |
| `filter.floodfill.reject` | `tests/differential/video-floodfill.test.ts` | `fails like native for out-of-range floodfill options before opening any output on every path` | option range refusal parity, with no output opened | all |
| `filter.floodfill.negotiation` | `tests/differential/video-floodfill.test.ts` | `negotiates every accepted source as native does and refuses the yuva444p and gbrap picks before output on every path` | native picks from 17 sources; yuva444p and gbrap refused by name on every path | all |
