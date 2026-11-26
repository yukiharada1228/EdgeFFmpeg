# threshold video filter

`threshold` is a four-input join: for every sample of the selected planes it outputs the `min` input's sample when the first input's sample is less than or equal to the `threshold` input's sample, and the `max` input's sample otherwise. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_threshold.c` and `vf_threshold_init.h` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-THRESHOLD`; the descriptor is `packages/avfilter/src/video-ops/threshold.ts`.

## Syntax

`[in][threshold][min][max]threshold[=planes]`, or the named option `planes`.

| Option | Type | Range | Default |
|---|---|---|---|
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |

The value is parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`): expressions, hexadecimal input, the `default`, `min`, `max`, `none` and `all` constants, rounding half to even. A value outside the range fails with `Invalid threshold planes: ...`. Later occurrences win.

The filter has four input pads in native order (`default`, `threshold`, `min`, `max`) and one output. Per sample, `dst = in <= threshold ? min : max` (`threshold8`); a tie takes `min`. A plane whose bit is not set is copied from the first input. Bits without a plane (bit 3 for three-plane formats, bits 1 to 3 for gray) are ignored. For gbrp the bits follow the plane index, G=1, B=2, R=4. Frame properties (timestamp, metadata) come from the first input, as `av_frame_copy_props(out, in)` does.

## Synchronization

Native `config_output` sets `sync=1`, `before=EXT_STOP` and `after=EXT_STOP` on all four framesync inputs, so the output ends as soon as any input ends. That is the `vf_stack` `shortest=1` behaviour, and the step carries a constant `shortest: true` for the shared join engines. Native has no `shortest` option, so `shortest=`, `eof_action=`, `repeatlast=` and `ts_sync_mode=` are refused as unknown options. With inputs of 3, 2, 3 and 3 frames both native and EdgeFFmpeg give 2 frames.

## Formats

`formats()` is the native `pix_fmts` list in declared order (57 formats, `yuvj` included, no `jpegSiblings`). The four inputs share one format, as `ff_set_common_formats` does. Frames run here in the six eight-bit layouts with frame storage: `yuv444p`, `yuv422p`, `yuva420p`, `yuv420p`, `gbrp` and `gray`. Other sources get native's automatic conversion: nv12 and nv21 to yuv420p, rgb24 and bgr24 to gbrp. Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively, which has no frame storage here; the negotiators refuse it at plan time with `negotiates gbrap, which is not implemented`, before any output is opened.

## Refused forms

- Inputs of different sizes: `Threshold input sizes differ`, from `geometry()` at plan time and again in `combine`. Native fails in `config_output` with `AVERROR(EINVAL)` (exit status 234). EdgeFFmpeg exits with status 1, because filter plan errors do not carry an errno through the shared backends (see Notes).
- `enable=`: `Threshold timeline expressions are not implemented`. Native supports the internal timeline.
- Runtime commands (`planes`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with an error code. Native accepts them.
- `shortest`, `threads` and every other option: `Unsupported threshold option`.
- The linear path: a join is never linear, so `-vf threshold` on the media backend fails with `Unsupported video filter`.
- In `combine`: anything other than four frames, mismatched sizes or formats, unsupported layouts, malformed planes or strides, budgets over `maxFrameBytes`, invalid or unsynchronized timestamps. `AbortSignal` is checked before work and on every row.

## Unsupported scope

- High-bit-depth formats (9 to 16 bit), `yuv440p`, `yuv411p`, `yuv410p`, `yuvj*`, `yuva422p`, `yuva444p` and `gbrap`: no frame storage here; any negotiation that picks one is refused by name.
- **Inputs with different frame rates.** Native sets the output frame rate to the first input's; the shared join clocks follow `vf_stack`, which clears it when the rates differ. A probe with rates 25/50/50/50 and 50/25/25/25 gave different rawvideo and framecrc output on the media and timed backends. This cannot be refused from the descriptor, because `geometry()` does not see frame rates. Only equal rates are tested and claimed.
- `enable=` timelines and runtime commands.

## Paths

`graph`, `stream`, `actor` and `timed`, through the shared join role (`combine` after timestamp synchronization). The registry test runs the three descriptor examples on every flagged path and checks the rejection on `linear`.

## Determinism

Integer comparison and selection only: no rounding, no arithmetic profile, the same on every platform. The reference is built with `--disable-x86asm`, so native runs the C `threshold8`. Native slices are independent row ranges, and `-filter_threads 1` gives the same output as the default thread count.

## Evidence

`tests/differential/video-threshold.test.ts` runs `.build/reference/ffmpeg` at test time and checks `build-metadata.json` for commit `946fcce0` and `--disable-x86asm`. It ran in a Linux x86_64 sandbox against an unpinned local build (ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`), Node 24.22.3. Inputs combine ramps, 0/128/255 edges and constant planes with LCG noise.

| Test title | Path | Comparisons |
|---|---|---|
| `matches native split-from-one-source threshold on the graph path across every executable format, size, tie and plane mask` | graph (`compileVideoFilterGraph`) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 6 split graphs (distinct branches, ties where in == threshold, planes 15/1/5/0/10), 3 frames: 216 |
| `matches native split-from-one-source threshold CLI rawvideo and framecrc on the media backend graph path, with and without -ss/-t` | graph CLI `-filter_complex` | 6 formats x {5x3, 8x6} x 6 graphs x {rawvideo, framecrc, framecrc with -ss/-t}: 216 |
| `matches native four-input threshold CLI rawvideo and framecrc on the stream path, ending with the shortest input, with and without -ss/-t` | stream (multi-input CLI) | 6 formats/sizes x 5 length sets (3,3,3,3; 3,2,3,3; 1,3,3,3; 3,3,3,2; 4,3,2,4) x 2 graphs x {rawvideo, framecrc} x {none, -ss/-t}: 240 |
| `matches native threshold through createReplayVideoExecution with four distinct sources of unequal lengths and split graphs` | stream (`createReplayVideoExecution`) | 4 formats x 5 length sets x 2 graphs, bytes and timestamps: 40 |
| `matches native threshold through the timed backend on the actor and timed paths in rawvideo and framecrc, with unequal lengths` | actor (`producer`), timed (`pull`) | 4 formats x (3 length sets x 2 graphs x 2 muxers x 2 schedulers + 3 split graphs x 2 schedulers): 120 |
| `agrees with native under default threads and -filter_threads 1` | native only | 6 formats x 2 graphs: 12 |
| `refuses size mismatches and unsupported options that native refuses before opening any output on every path` | graph, stream, actor, timed, linear | 8: native fails (234 for sizes), EdgeFFmpeg exits 1 without opening an output |
| `negotiates every accepted source as native does and refuses picks without frame storage by name before output on every join path` | graph, stream, actor, timed, CLI | 14 storage sources; native's pick read from showinfo; 10 byte-exact on four paths, argb/rgba/abgr/bgra refused naming gbrap on four paths and three CLI backends: 68 checks |

Total: 920 native comparisons. Three mutations were each caught: `<` instead of `<=` (6 tests failed), ignoring the plane mask (5 failed) and `shortest: false` (3 failed).

The shared helper `tests/helpers/video-negotiation-cases.ts` always drives the linear path, which a join never flags, so the negotiation test reimplements the same per-source check over the four join paths, reading `negotiationSources` from the helper.

`tests/unit/video-threshold.test.ts` (4 tests) covers parsing, ranges and messages, the refused `shortest`/framesync/`enable=` options, the pinned format list, ties, plane masks, an unmutated padded input, owned output planes, MIN timestamp clamping, size and format mismatches, budgets, malformed strides and plane counts, invalid settings and timestamps, `AbortSignal`, graph and timed planning, the linear refusal and refused runtime commands.

## Proposed test contracts

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.threshold.graph` | `tests/differential/video-threshold.test.ts` | `matches native split-from-one-source threshold on the graph path across every executable format, size, tie and plane mask` | six eight-bit formats, six sizes, ties and plane masks |
| `filter.threshold.graph-cli` | `tests/differential/video-threshold.test.ts` | `matches native split-from-one-source threshold CLI rawvideo and framecrc on the media backend graph path, with and without -ss/-t` | `-filter_complex` rawvideo and framecrc, -ss/-t |
| `filter.threshold.stream-cli` | `tests/differential/video-threshold.test.ts` | `matches native four-input threshold CLI rawvideo and framecrc on the stream path, ending with the shortest input, with and without -ss/-t` | four distinct inputs, equal rates, unequal lengths end with the shortest |
| `filter.threshold.stream` | `tests/differential/video-threshold.test.ts` | `matches native threshold through createReplayVideoExecution with four distinct sources of unequal lengths and split graphs` | replay streams, timestamps |
| `filter.threshold.timed` | `tests/differential/video-threshold.test.ts` | `matches native threshold through the timed backend on the actor and timed paths in rawvideo and framecrc, with unequal lengths` | timed backend producer and pull |
| `filter.threshold.threads` | `tests/differential/video-threshold.test.ts` | `agrees with native under default threads and -filter_threads 1` | native slice-thread invariance |
| `filter.threshold.reject` | `tests/differential/video-threshold.test.ts` | `refuses size mismatches and unsupported options that native refuses before opening any output on every path` | size mismatch and option refusals, no output opened |
| `filter.threshold.negotiation` | `tests/differential/video-threshold.test.ts` | `negotiates every accepted source as native does and refuses picks without frame storage by name before output on every join path` | native picks from 14 sources; gbrap refused by name |

All contracts are integer-only and run on every platform (modes `semantic`, `bit-exact`).

## Notes

- Matching native's exit status 234 for the size mismatch needs a shared change: the backends would have to map avfilter plan-time geometry errors to `ExecutionError` with `AVERROR(EINVAL)`.
- Refusing inputs with different frame rates, or matching native's first-input frame rate, needs a join frame-rate hook in the descriptor contract or frame rates in `geometry()` inputs.
