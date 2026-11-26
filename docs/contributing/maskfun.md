# maskfun video filter

`maskfun` binarises the selected planes: a sample `<= low` becomes 0, a sample `> high` becomes the maximum (255), and anything in between is kept. Before that, it sums the selected planes. If the sum reaches `sum` times their area, the frame is replaced by an empty frame filled with `min(fill, 255)` on every plane. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_maskfun.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-MASKFUN`, and the descriptor is in `packages/avfilter/src/video-ops/maskfun.ts`.

## Syntax

`maskfun[=low:high:planes:fill:sum]`, or the named options in any order. If an option appears more than once, the last value wins.

| Option | Type | Range | Default |
|---|---|---|---|
| `low` | `AV_OPT_TYPE_INT` | 0..65535 | 10 |
| `high` | `AV_OPT_TYPE_INT` | 0..65535 | 10 |
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |
| `fill` | `AV_OPT_TYPE_INT` | 0..65535 | 0 |
| `sum` | `AV_OPT_TYPE_INT` | 0..65535 | 10 |

Values are parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, hexadecimal, the `default`/`min`/`max` constants, and rounds half to even. A value outside its range fails with `Invalid maskfun <option>: ...` while parsing, on every path, before any negotiation, input read or output open. Native has no check across options, so `low > high` is accepted: every sample then becomes 0 or 255.

## Semantics

These follow `filter_frame`, `getsum8`, `maskfun8`, `set_max_sum` and `fill_frame`:

- **Threshold.** `max_sum = sum × Σ(planewidth × planeheight)` over the selected planes that exist. The sum of the selected samples is checked after each row with `sum >= max_sum` (not `>`). The test is monotone, so stopping at the first row that crosses gives the same answer as a full sum. It is computed with bigint row totals, so it cannot overflow.
- **Empty frame.** If the threshold is crossed, every plane, selected or not, is filled with `min(fill, 255)`. The empty frame gets the input pts. Native allocates it from the input link, so its aspect ratio and colour properties are the link's. Here they are the input frame's `metadata`.
- **Edge cases.** With `sum=0` and at least one selected plane that exists, every frame is empty. If `planes` selects no existing plane (`planes=0`, or bits 1 to 3 on gray), `max_sum` is 0, no row is read, the frame is never empty, and it passes through unchanged.
- **Binarisation.** On the selected planes, `<= low` gives 0, `> high` gives 255, and other samples are kept. Unselected planes are copied (the input pad is `NEEDS_WRITABLE`, so native writes in place). For gbrp the bits follow the plane index: G=1, B=2, R=4.

## Formats

`formats()` is the native `pix_fmts` list in declared order: 55 formats covering planar YUV, YUVA, GBR(A)P and gray at every depth, including `yuvj`. It has no `yuva422p12`/`yuva444p12`. With this list the shared negotiators pick exactly what native picks. Frames run here in the six eight-bit layouts with frame storage: `gray`, `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p` and `gbrp`. They also run in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. Other inputs get native's automatic conversion: nv12 and nv21 become yuv420p, and rgb24 and bgr24 become gbrp.

Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively. `gbrap` has no frame storage here, so the negotiators refuse it at plan time with `Video filter maskfun input negotiates gbrap, which is not implemented`, on every path and before any output is opened.

## Refused forms

- `enable=`: `Maskfun timeline expressions are not implemented`. Native supports the generic timeline.
- Runtime commands (`low`, `high`, `planes`, `fill`, `sum`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them.
- Any other option, such as `threads`: `Unsupported maskfun option`.
- Frames in a format other than the supported ones fail with an explicit error. So do malformed planes or strides, budgets over `maxFrameBytes`, out-of-range settings and invalid time bases. `AbortSignal` is checked before work and on every row.

## Unsupported scope

- **Packed RGB with alpha.** It negotiates `gbrap` natively and is refused before output (see Formats).
- **Formats without frame storage.** These are the high-bit-depth formats (9 to 16 bit, the `maskfun16`/`getsum16` paths), `yuv440p`, `yuv411p`, `yuv410p`, `yuvj440p`, `yuvj411p`, `yuva422p`, `yuva444p` and `gbrap`. Any negotiation that picks one is refused by name.
- **Timeline and commands.** `enable=` timelines and runtime commands are refused.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` all run the stateless `frame` function. The registry examples are `maskfun`, `maskfun=low=100:high=50:sum=255`, `maskfun=fill=77:sum=0,hflip` and `maskfun=0:255:1:9:300`. The registry test runs them on every path from an 8x8 gray source.

## Determinism

Only integer compares, sums and fills are used, with no floating point and no arithmetic profile, so results are the same on every platform. No case is gated to linux-x64. The Linux reference is built with x86 assembly disabled, and vf_maskfun has no assembly anyway. The output does not depend on the thread count. `getsum` runs before slicing, and native slices are independent row ranges. The threads test checks this.

## Evidence

`tests/differential/video-maskfun.test.ts` runs `.build/reference/ffmpeg` at test time. It first reads `.build/reference/build-metadata.json` and asserts commit `946fcce0` and `--disable-x86asm`. It ran on a linux x64 sandbox build of the reference (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v22.23.5). The file takes about 5 s.

The inputs have three frames. The first is dark, with a mean below the default `sum`, plus 200 and 11 edges. The second is LCG noise with ramps and 0/255 extremes. The third has constant 255 planes. So the threshold is crossed on some frames and not on others:

| Test title | Path | Comparisons |
|---|---|---|
| `matches native linear maskfun thresholds, plane masks and empty frames across every executable format and size` | linear (`compileVideoFilterChain`) | 6 formats × 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) × 8 option sets (defaults, `low=0:high=255`, `low=100:high=50`, `planes=1`, `planes=5`, `fill=77:sum=0`, `sum=255`, `fill=300:sum=0:planes=2`): 288 three-frame rawvideo byte matches. Of the 864 frames, 643 cross the threshold (each checked to be `min(fill,255)` everywhere) and 221 are binarised. |
| `matches native maskfun CLI rawvideo and framecrc on the linear path with and without -ss/-t, including implicit conversions` | linear CLI `-vf` | 8 sources (the six formats plus nv12 and rgb24 through conversion, `-cpuflags 0`) × 6 chains × {rawvideo, framecrc} × {untrimmed, `-ss 0.04 -t 0.04`}: 192 |
| `matches native maskfun with default threads and with -filter_threads 1` | linear, native threads | 6 formats × {17x9, 64x48} × 3 chains: 36. Native's default threads, `-filter_threads 1` and EdgeFFmpeg all agree. |
| `matches native maskfun filter_complex branches on the graph path in rawvideo and framecrc` | graph CLI `-filter_complex` | 4 sources × 2 graphs × 2 muxers, two outputs each: 16 cases, 32 files |
| `matches native maskfun on the stream path through replay execution and the multi-input CLI` | stream | 6 `createReplayVideoExecution` rawvideo cases and 2 multi-input CLI cases: 8 |
| `matches native maskfun through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer`), timed (`pull`) | 3 sources × 3 chains × 2 muxers × 2 schedulers: 36 |
| `fails like native for out-of-range maskfun options before opening any output on every path` | linear, graph, stream, actor, timed | 6 rejections: native exits non-zero with no output file, and EdgeFFmpeg exits non-zero without opening an output |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | linear, graph, stream, actor, timed, CLI | `maskfun=low=100:high=150:sum=255` from 17 sources, with native's pick read from showinfo. 13 run byte-exact on the five paths; argb, rgba, abgr and bgra are refused naming `gbrap`. 89 checks |

Three mutations were each caught by this file:

- `<= low` changed to `< low`: 6 tests failed.
- `sum >= max_sum` changed to `>`: 6 tests failed.
- The fill not clamped to 255: 2 tests failed.

`tests/unit/video-maskfun.test.ts` has 5 tests. They cover:

- parsing, ranges and messages;
- the declared format list;
- binarisation with plane masks, including gbrp and yuva;
- the threshold boundary (`>=`), the fill clamp, planes that select no plane, and an empty frame that fills unselected planes;
- budgets, malformed strides and plane counts, invalid settings and `AbortSignal`;
- an unmutated padded input and owned output planes;
- planning on the linear, graph and actor parsers, the gbrap refusal, `enable=`, and refused runtime commands.

## Proposed test contracts

All cases are integer-only and run on every platform (no `platforms` gate).

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.maskfun.linear` | `tests/differential/video-maskfun.test.ts` | `matches native linear maskfun thresholds, plane masks and empty frames across every executable format and size` | the six eight-bit formats, six sizes, every option class, threshold crossings |
| `filter.maskfun.cli` | `tests/differential/video-maskfun.test.ts` | `matches native maskfun CLI rawvideo and framecrc on the linear path with and without -ss/-t, including implicit conversions` | `-vf` rawvideo and framecrc, trimmed and untrimmed, nv12/rgb24 conversions |
| `filter.maskfun.threads` | `tests/differential/video-maskfun.test.ts` | `matches native maskfun with default threads and with -filter_threads 1` | thread-count independence |
| `filter.maskfun.graph` | `tests/differential/video-maskfun.test.ts` | `matches native maskfun filter_complex branches on the graph path in rawvideo and framecrc` | `-filter_complex` with two outputs |
| `filter.maskfun.stream` | `tests/differential/video-maskfun.test.ts` | `matches native maskfun on the stream path through replay execution and the multi-input CLI` | replay streams and the multi-input CLI |
| `filter.maskfun.timed` | `tests/differential/video-maskfun.test.ts` | `matches native maskfun through the timed backend on the actor and timed paths in rawvideo and framecrc` | the timed backend's `producer` and `pull` schedulers |
| `filter.maskfun.reject` | `tests/differential/video-maskfun.test.ts` | `fails like native for out-of-range maskfun options before opening any output on every path` | option range refusal parity, with no output opened |
| `filter.maskfun.negotiation` | `tests/differential/video-maskfun.test.ts` | `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | native picks from 17 sources; gbrap refused by name on every path |
