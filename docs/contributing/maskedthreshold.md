# maskedthreshold video filter

`maskedthreshold` takes two inputs, `source` and `reference`, of the same size and format. For each sample of a selected plane it picks between the two by comparing their difference with a threshold. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_maskedthreshold.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-MASKEDTHRESHOLD`. The descriptor is `packages/avfilter/src/video-ops/maskedthreshold.ts`.

## Syntax

`[source][reference]maskedthreshold[=threshold:planes:mode]`, or the named options `threshold`, `planes` and `mode` in any order. When an option is given twice, the later one wins.

| Option | Type | Range | Default |
|---|---|---|---|
| `threshold` | `AV_OPT_TYPE_INT` | 0..65535 | 1 |
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |
| `mode` | `AV_OPT_TYPE_INT` with the constants `abs` (0) and `diff` (1) | 0..1 | `abs` |

The values are parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, the named mode constants and `default`, `min`, `max`, `none` and `all`, and it rounds half to even. A value outside its range fails with `Invalid maskedthreshold <option>: ...`. For example, `planes=all` is -1, which is out of range, as it is in native.

## Semantics

These are the eight-bit kernels. With `s` the source sample, `r` the reference sample and `t` the threshold:

- `abs` (`threshold8_abs`): `|s - r| <= t ? s : r`.
- `diff` (`threshold8_diff`): `r - s <= t ? max(r - t, 0) : s`. This uses signed int arithmetic, so a negative `r - s` always takes the first branch. Thresholds above 255 are allowed. In `diff` mode such a threshold gives 0 wherever `r - s <= t`.
- A plane whose bit is not set in `planes` is **copied from the reference input**. `threshold_slice` calls `av_image_copy_plane(dst, ..., ref, ...)`. The wave-2 scope line says "copied from source", but native copies from the reference, and both the differential and the unit tests pin the reference copy. Bits are plane indices: for gbrp, G=1, B=2, R=4. Bits with no plane are ignored.
- The output takes its frame properties from the source (`av_frame_copy_props`): metadata, plus the size, sample aspect ratio and frame rate of the source link. Its timestamp is the sync event's. Rescaling without `PASS_MINMAX` clamps `INT64_MIN` to `INT64_MIN + 1`.

### Synchronization

Both inputs use `sync=1`, `before=EXT_STOP` and `after=EXT_INFINITY`: the vf_stack semantics of the shared join engines. With unequal lengths, the output lasts as long as the longer input, and the shorter input's last frame is repeated. The filter declares no framesync options: native refuses `shortest`, `eof_action`, `repeatlast` and `ts_sync_mode` with `Option not found`, and so does EdgeFFmpeg. The step's `shortest` is therefore always `false`. This differs from the generic `[FS-OPTS]` note, which says "accept shortest". Native has no such option, so it is refused here.

## Formats

`formats()` returns the native `pix_fmts` list in declared order: 57 formats covering planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included. Both pads share it, as `ff_set_common_formats` requires, so the shared negotiators pick exactly what native picks. Frames run here in the six eight-bit layouts that have frame storage: `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p` and `gbrp`. Other sources get native's automatic conversion: nv12 and nv21 become yuv420p, and rgb24 and bgr24 become gbrp. Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively. `gbrap` has no storage here, so it is refused at plan time on every path with `Video filter maskedthreshold input negotiates gbrap, which is not implemented`.

## Refused forms

- **Differing input sizes.** `geometry()` refuses them on every path with native's message, `First input link source parameters (size WxH) do not match the corresponding second input link reference parameters (WxH)`. `combine` repeats the check. Native fails with `EINVAL` from `config_output` and writes no frames.
- **`enable=`.** Fails with `Maskedthreshold timeline expressions are not implemented`. Native supports the timeline internally (`AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL`).
- **Runtime commands** (`threshold`, `planes`, `mode`). The descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer with the unsupported code (-38). Native accepts `threshold` and `planes` at runtime.
- **Framesync options** (`shortest`, `eof_action`, `repeatlast`, `ts_sync_mode`) and generic options such as `threads`. All fail with `Unsupported maskedthreshold option`. Native also refuses the framesync options.
- **Malformed input.** Frames of differing formats, sizes or timestamps, formats other than the six above, malformed planes or strides, budgets over `maxFrameBytes`, and invalid time bases all fail with explicit errors. `AbortSignal` is checked before work and on every row.

## Unsupported scope

- High-bit-depth formats (`threshold16_*`), `yuv440p`, `yuv411p`, `yuv410p`, `yuvj440p`, `yuvj411p`, `yuva422p`, `yuva444p` and `gbrap`. None has frame storage here, and a negotiation that picks one is refused by name.
- Packed RGB with alpha sources, which go through `gbrap` natively.
- `enable=` timelines and runtime commands.
- The `linear` path. A join is never linear.

## Paths

`graph`, `stream`, `actor` and `timed`, through `combine` and `geometry` (role `join`, `stateful`). The registry test runs the four descriptor examples on each of these paths and requires identical output. It also checks the `linear` rejection.

## Determinism and arithmetic profile

The kernels use only integer comparisons and subtraction: no rounding and no float. They run on every platform. Native slices are independent row ranges, so the output does not depend on the thread count. The Linux reference is built with `--disable-x86asm`. The filter has no assembly anyway. Implicit conversions in the tests (nv12, rgb24, and `format=yuv444p` from other sources) run native with `-cpuflags 0` and EdgeFFmpeg with scalar arithmetic. There are no linux-gated cases.

## Evidence

`tests/differential/video-maskedthreshold.test.ts` runs `.build/reference/ffmpeg` at test time. It checks `build-metadata.json` for commit `946fcce0` and `--disable-x86asm`; it does not pin a binary digest. The inputs mix LCG noise with ramps, 0/255 edges, reference values within ±2 of the source (plus some +40 outliers) and constant reference planes.

| Test title | Path | Comparisons |
|---|---|---|
| `runs against the pinned-commit sandbox reference built without x86 assembly` | none | provenance check |
| `matches native maskedthreshold for every mode, threshold 0/1/255 and plane mask over every format and size on the graph path` | graph (`compileMultiInputVideoFilterGraph`, two distinct inputs) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 2 patterns x 24 variants (threshold {0,1,255} x mode {abs,diff} x planes {15,1,10,0}). That is 1728 three-frame rawvideo matches from 72 native runs. Each match also checks that the inputs are not mutated and that the source timestamp is kept. |
| `matches native two-input maskedthreshold rawvideo and framecrc with unequal lengths and -ss/-t on the stream, actor and timed CLIs` | stream (media multi-input CLI), actor (timed `producer`), timed (timed `pull`) | 6 format/size pairs x lengths {3/3, 3/2, 2/3} x 3 filters x {none, `-ss 0.04`, `-t 0.08`} x {rawvideo, framecrc} x 3 paths: 972 |
| `matches native split-from-one-source maskedthreshold graphs, with implicit conversions, on the graph, stream, actor and timed paths` | graph (media single-input `-filter_complex`), stream, actor, timed | 5 sources (gray, yuv420p, nv12, rgb24, yuva420p) x 4 graphs (hflip/vflip branches, `format=yuv444p`) x 2 muxers x 4 paths: 160 |
| `matches native maskedthreshold through replay execution, frame actors and the timed executor APIs with distinct inputs` | stream (`createReplayVideoExecution`), actor (`createFrameActors`), timed (`executeTimedGraph`) | 3 formats x 2 filters x 3 APIs, with inputs of 3 and 2 frames: 18 |
| `refuses size mismatches, framesync options, enable= and out-of-range options like native before opening any output on every path` | graph, stream, actor, timed | 9 refusals x 3 two-input paths, plus 2 single-input graphs x 4 paths: 35. Native exits non-zero with an empty output (or, for `enable=`, accepts what EdgeFFmpeg refuses). EdgeFFmpeg exits non-zero without opening an output. |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every join path` | graph, stream, actor, timed, CLI | 14 non-legacy sources, with native's pick read from showinfo. 10 run byte-exact on the 4 paths. argb, rgba, abgr and bgra are refused naming `gbrap` on the 4 paths and on the media graph, media stream, timed producer and timed pull CLIs. 72 checks. |

Two mutations were each caught by the matrix test: copying unselected planes from the source, and returning the reference instead of the source in the `diff` else-branch.

`tests/differential` total: 7 tests, about 16 s on 4 vCPUs with `--maxWorkers=1`.

`tests/unit/video-maskedthreshold.test.ts` (4 tests) covers:

- parsing, ranges, the named modes, and every refusal message, including the framesync options and `enable=`;
- both kernels, the reference-plane copy, owned output planes, source properties, and unmutated padded inputs;
- the `INT64_MIN` timestamp clamp;
- geometry, format and timestamp mismatches, budgets, malformed strides and plane counts, invalid settings and `AbortSignal`;
- the `linear` rejection, the plan-time size refusals on the graph and timed planners, and refused runtime commands on the actors.

Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` on linux x64. The tests ran with Node v22.23.5, because Node 24 could not be installed in the sandbox.

## Proposed test contracts

All of these are for every platform, with no gating.

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.maskedthreshold.graph` | `tests/differential/video-maskedthreshold.test.ts` | `matches native maskedthreshold for every mode, threshold 0/1/255 and plane mask over every format and size on the graph path` | both kernels, thresholds 0/1/255, plane masks, six formats, six sizes |
| `filter.maskedthreshold.cli` | `tests/differential/video-maskedthreshold.test.ts` | `matches native two-input maskedthreshold rawvideo and framecrc with unequal lengths and -ss/-t on the stream, actor and timed CLIs` | `[JOIN-SYNC]` with unequal lengths and trims on the stream, actor and timed paths |
| `filter.maskedthreshold.split` | `tests/differential/video-maskedthreshold.test.ts` | `matches native split-from-one-source maskedthreshold graphs, with implicit conversions, on the graph, stream, actor and timed paths` | split graphs and conversions on all four join paths |
| `filter.maskedthreshold.api` | `tests/differential/video-maskedthreshold.test.ts` | `matches native maskedthreshold through replay execution, frame actors and the timed executor APIs with distinct inputs` | public stream, actor and timed APIs |
| `filter.maskedthreshold.reject` | `tests/differential/video-maskedthreshold.test.ts` | `refuses size mismatches, framesync options, enable= and out-of-range options like native before opening any output on every path` | refusal parity, with no output opened |
| `filter.maskedthreshold.negotiation` | `tests/differential/video-maskedthreshold.test.ts` | `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every join path` | native picks from 14 sources, with gbrap refused by name |
