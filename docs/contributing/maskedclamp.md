# maskedclamp video filter

`maskedclamp` clamps each sample of its first input (`base`) between the matching samples of its second (`dark`) and third (`bright`) inputs. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_maskedclamp.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-MASKEDCLAMP`; the descriptor is `packages/avfilter/src/video-ops/maskedclamp.ts`.

## Syntax

`[base][dark][bright]maskedclamp[=undershoot:overshoot:planes]`, or the named options `undershoot`, `overshoot` and `planes`, in any order. A later occurrence of an option wins.

| Option | Type | Range | Default |
|---|---|---|---|
| `undershoot` | `AV_OPT_TYPE_INT` | 0..65535 | 0 |
| `overshoot` | `AV_OPT_TYPE_INT` | 0..65535 | 0 |
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |

The values are parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, hexadecimal input and the `default`, `min`, `max`, `none` and `all` constants, and it rounds half to even. A value outside its range fails with `Invalid maskedclamp <option>: ...`. Native fails these with ERANGE (exit 222 on Linux).

For each selected plane the filter computes `dst = min(max(base, dark - undershoot), bright + overshoot)`, in the order `maskedclamp8` uses. When the bounds cross (`dark - undershoot > bright + overshoot`), the bright check comes last, so the result is `bright + overshoot`. `config_input` clamps both shoots to `(1 << depth) - 1`. All supported layouts are 8-bit, and the clamp to 255 cannot change an 8-bit result. A plane whose bit is not set in `planes` is copied from `base`. Bits without a plane are ignored. For gbrp the bits follow the plane index (G=1, B=2, R=4).

The output takes its size, properties and metadata from `base` (`av_frame_copy_props`). The timestamp is the framesync event time, rescaled to the output time base, which is the same time base, with the same MIN to MIN+1 clamp as vf_stack.

## Synchronization

Native maskedclamp configures framesync with every input at `sync=1`, `before=EXT_STOP` and `after=EXT_INFINITY`. This is the vf_stack join semantics of the shared join role with `shortest=0`. Inputs of unequal length repeat their last frame until every input has ended. Native maskedclamp declares its class with `AVFILTER_DEFINE_CLASS`, not `FRAMESYNC_DEFINE_CLASS`, so it has no `shortest`, `eof_action`, `repeatlast` or `ts_sync_mode` option. Native fails each of them with `Option not found` (exit 8), and they are refused here with `Unsupported maskedclamp option`. The step always carries `shortest: false`.

This differs from the wave specification's [FS-OPTS] wording, which says to accept `shortest`. The native filter refuses `shortest`, so accepting it would diverge from native.

## Formats

`formats()` returns the native `pix_fmts` list in declared order: 57 formats of planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included. All three inputs share one format, as `ff_set_common_formats` requires. Frames run here in the six 8-bit layouts that have frame storage: `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p` and `gbrp`. Other sources get native's automatic conversion: nv12 and nv21 convert to yuv420p, and rgb24 and bgr24 convert to gbrp.

Natively, packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap`, which has no frame storage here. The negotiators refuse it at plan time with `Video filter maskedclamp input negotiates gbrap, which is not implemented`, on every path and before any output is opened.

## Refused forms

- **Differing input sizes.** `geometry()` refuses them on every path before output: `Maskedclamp input sizes differ: base WxH, dark WxH, bright WxH`. Native fails `config_output` with EINVAL (exit 234 on Linux, from `os.constants.errno.EINVAL` on the host). Native creates its output file before it fails; EdgeFFmpeg opens no output. The check is repeated in `combine`.
- **Framesync options** `shortest`, `eof_action`, `repeatlast` and `ts_sync_mode`: `Unsupported maskedclamp option`. Native refuses them too.
- **`enable=`**: `Maskedclamp timeline expressions are not implemented`. Native accepts it through `AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL`.
- **Generic `threads=`**: `Unsupported maskedclamp option`. Native accepts it.
- **Runtime commands** (`undershoot`, `overshoot`, `planes`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the activation actors answer them with the unsupported code. Native accepts them through `ff_filter_process_command`.
- **Linear chains** (`-vf maskedclamp`): a join is never linear.
- **Invalid frames.** Frames in other formats, malformed planes or strides, budgets over `maxFrameBytes`, invalid time bases and a frame count other than three fail with explicit errors. `AbortSignal` is checked before work and on every row.

## Unsupported scope

- **Unequal input frame rates.** Native sets the output frame rate to the base input's rate (`ol->frame_rate = il->frame_rate`). The shared join role uses the common rate when every input has the same rate and `1/0` otherwise, which is the vf_stack behaviour. With inputs at 25/10/25 fps, framecrc output differed from native on the stream, actor and timed paths. With 10/25/25 fps, rawvideo output differed as well, because the CFR output clock differs. Rawvideo at 25/10/25 fps matched. The descriptor cannot see frame rates, so it can neither refuse these inputs nor fix them. That needs a shared join-clock hook (see the report's `sharedEditsNeeded`). Until then, only equal input rates are supported. Nothing in the tests claims more than that.
- **Formats without frame storage.** The high-bit-depth formats (9 to 16 bit), `yuv440p`, `yuv411p`, `yuv410p`, `yuvj*`, `yuva422p`, `yuva444p` and `gbrap` have no frame storage here. Any negotiation that picks one is refused by name.
- **Timelines and commands.** `enable=` timelines and runtime commands are refused (see Refused forms).

## Paths

`graph`, `stream`, `actor` and `timed`, through the join role's synchronization followed by `combine`. The registry test runs the three descriptor examples on all four paths and checks that they agree.

## Determinism

The filter does only integer max and min, with no rounding and no arithmetic profile. The Linux reference is built with `--disable-x86asm`, so native runs the C `maskedclamp8`. Native slices are independent row ranges, and native output with the default thread count equals output with `-filter_threads 1` (tested). The tests run on every platform; no case is gated.

## Evidence

`tests/differential/video-maskedclamp.test.ts` runs `.build/reference/ffmpeg` at test time. It first checks that `.build/reference/build-metadata.json` records commit 946fcce0 and `--disable-x86asm`. It compares no pinned digests. The sandbox reference sha256 was `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` on linux x64. The tests ran under Node v22.23.5, because installing Node 24 was not permitted in the sandbox. Native runs with `-cpuflags 0` and EdgeFFmpeg uses scalar arithmetic for every implicit conversion. The whole file finishes in about 6 s.

| Test title | Paths | Comparisons |
|---|---|---|
| `matches native maskedclamp on three distinct inputs across formats, sizes, bounds, inversions and plane masks` | stream (multi-input CLI) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 2 input sets x 8 option sets: 576 rawvideo byte matches. The input sets are (a) three distinct noise-plus-ramp inputs of 3, 2 and 4 frames and (b) a ramp base between constant dark 200 and bright 50, so bounds are crossed everywhere. The option sets are the defaults, 5:5, 255:255, 5/255, planes 1, 6 and 0, and 300:65535:9. |
| `matches native maskedclamp rawvideo and framecrc on the graph, stream, actor and timed paths with and without -ss/-t` | graph (one-source split graph), stream (3 inputs of 4, 3 and 5 frames), actor (producer, 1 and 3 inputs), timed (pull, 1 and 3 inputs) | 6 format/size pairs x 6 backends x 4 time selections (none, `-ss 0.04`, `-t 0.08`, both) x {rawvideo, framecrc}: 288 |
| `refuses size mismatches, framesync and out-of-range options and enable= before opening any output on every path` | media (graph and stream), actor, timed | 13 cases x 3 backends: 39. Each pins the native exit status (EINVAL, option not found, ERANGE, or 0 for the natively accepted `enable=` and `threads=`), EdgeFFmpeg exit 1, the diagnostic, and no output opened. |
| `negotiates every accepted source as native does on the four join paths and refuses picks without storage by name` | graph, stream, actor x2, timed x2 | 14 sources, with native's pick read from showinfo: 10 match byte-exact, and argb, rgba, abgr and bgra are refused naming `gbrap` with no output opened. 84 checks. |
| `agrees with native under default slice threads and -filter_threads 1` | stream | 3 formats at 17x9: native threaded equals native single-thread equals EdgeFFmpeg |

Total: 990 native comparisons. A mutation that applied the bright bound before the dark bound was caught by the first test, on the crossed-bounds set.

`tests/unit/video-maskedclamp.test.ts` (5 tests) covers parsing, ranges, messages and every refused option. It also covers geometry refusals, the clamp order on crossed bounds, the shoot values 0, 5, 255 and 65535, plane masks on yuva420p, owned tight output and an unmutated padded input. Further tests cover metadata and pts from base, the MIN timestamp clamp, budgets, malformed strides on each input, plane counts, invalid settings and `AbortSignal`. The last test covers the graph plan, linear refusal, multi-input geometry refusal, `enable=` refusal on the actor parser and refused runtime commands.

`tests/helpers/video-negotiation-cases.ts` could not be used as is. Its `nativeNegotiationOutcome` always runs the linear path, which a join does not have. The negotiation test therefore mirrors it on the four join paths, importing only `negotiationSources`.

## Proposed test contracts

All of them run on every platform.

| Id | File | Test title | Scope |
|---|---|---|---|
| `filter.maskedclamp.unit` | `tests/unit/video-maskedclamp.test.ts` | `clamps base between dark-undershoot and bright+overshoot with bright winning crossed bounds, into owned tight planes without mutating padded input` | kernel semantics and ownership |
| `filter.maskedclamp.kernel` | `tests/differential/video-maskedclamp.test.ts` | `matches native maskedclamp on three distinct inputs across formats, sizes, bounds, inversions and plane masks` | six 8-bit formats, six sizes, shoots 0, 5, 255 and above 255, crossed bounds, plane masks, unequal lengths |
| `filter.maskedclamp.paths` | `tests/differential/video-maskedclamp.test.ts` | `matches native maskedclamp rawvideo and framecrc on the graph, stream, actor and timed paths with and without -ss/-t` | four join paths, split and three-input graphs, output time selection, equal rates |
| `filter.maskedclamp.reject` | `tests/differential/video-maskedclamp.test.ts` | `refuses size mismatches, framesync and out-of-range options and enable= before opening any output on every path` | native status parity, no output opened |
| `filter.maskedclamp.negotiation` | `tests/differential/video-maskedclamp.test.ts` | `negotiates every accepted source as native does on the four join paths and refuses picks without storage by name` | native picks from 14 sources; gbrap refused by name |
| `filter.maskedclamp.threads` | `tests/differential/video-maskedclamp.test.ts` | `agrees with native under default slice threads and -filter_threads 1` | thread invariance |
