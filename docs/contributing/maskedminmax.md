# maskedmin and maskedmax video filters

`maskedmin` and `maskedmax` take three inputs of one size and format: `source`, `filter1` and `filter2`. For every sample of a selected plane, `maskedmin` outputs `filter2` when `|source - filter2| < |source - filter1|`, and `filter1` otherwise. `maskedmax` outputs `filter2` when `|source - filter2| > |source - filter1|`, and `filter1` otherwise. Ties keep `filter1` in both filters. A plane whose bit is not set in `planes` is copied from `source`.

The filters are adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_maskedminmax.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-MASKEDMINMAX`. The kernel, parser and geometry are in `packages/avfilter/src/video-maskedminmax.ts`. The descriptors are `packages/avfilter/src/video-ops/maskedmin.ts` and `maskedmax.ts`.

## Syntax

`[source][filter1][filter2]maskedmin[=planes]` and `[source][filter1][filter2]maskedmax[=planes]`, or the named option `planes=`. Later occurrences of the option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |

The value is parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`). It accepts expressions, hexadecimal input and the `default`, `min`, `max`, `none` and `all` constants, and it rounds half to even. A value outside the range fails with `Invalid maskedmin planes` (`Invalid maskedmax planes`). Native fails with `ERANGE`. Plane bits follow the native plane index, for example Y=1, U=2, V=4, A=8, and G=1, B=2, R=4 for `gbrp`.

The filters are joins. They run only inside filtergraphs (`-filter_complex`, or a `-vf` graph such as `split=3[a][b][c];[a][b][c]maskedmin`). A bare `maskedmin` in a linear chain is refused with `Unsupported video filter`.

## Synchronization

Native calls `ff_framesync_init` with three inputs, each with `sync=1`, `before=EXT_STOP` and `after=EXT_INFINITY`. These are the `vf_stack` semantics without `shortest`, and the shared join synchronization implements them on every path. An input that ends early repeats its last frame until the longest input ends. The output timestamp is the sync event rescaled to the framesync time base, and `INT64_MIN` is clamped to `INT64_MIN + 1`. The output size, sample aspect ratio and frame rate come from `source`. Frame properties, including metadata, are copied from `source`.

`vf_maskedminmax` has no framesync options. `shortest`, `eof_action`, `repeatlast` and `ts_sync_mode` therefore fail natively with `Option not found` (exit status 8). Here they fail with `Unsupported maskedmin option` (`Unsupported maskedmax option`), like any other unknown option.

## Formats

`formats()` returns the native `pix_fmts` list in declared order: 60 formats covering planar YUV, YUVA, GBR(A)P and gray at every depth, plus `grayf32`, `gbrpf32` and `gbrapf32`. `yuvj` formats are listed explicitly, so `jpegSiblings` is not set. The shared negotiators give all three pads one format, as `ff_set_common_formats` does, so they pick what native picks. Frames run here in the six eight-bit layouts that have frame storage: `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p` and `gbrp`. nv12 and nv21 inputs convert to yuv420p, and rgb24 and bgr24 inputs convert to gbrp, as they do natively.

Native converts packed RGB with alpha (rgba, bgra, argb, abgr) to `gbrap`. `gbrap` has no frame storage here, so the negotiators refuse it at plan time with `negotiates gbrap, which is not implemented`, before any output is opened.

## Refused forms

- Sources, filter1 and filter2 of different sizes. `geometry()` refuses them with `maskedmin input sizes differ` on every path, before output, and `combine` repeats the check. Native `config_output` fails with `EINVAL` after it has opened its output file.
- `enable=`: `maskedmin timeline expressions are not implemented`. Native supports the generic timeline (`AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL`).
- Runtime commands (`planes`, `enable`) are answered with the unsupported code. Native accepts them.
- Framesync options and every other unknown option: `Unsupported maskedmin option`.
- In `combine`: fewer or more than three frames, formats without storage, budgets over `maxFrameBytes`, malformed planes or strides, input storage above the budget, invalid or unsynchronized timestamps, and invalid steps all fail with explicit errors. `AbortSignal` is checked before any work and on every row.

EdgeFFmpeg's CLI exits with status 1 for every refusal. The tests record native's status (EINVAL, ERANGE or 8) and require a non-zero exit with no output opened here.

## Paths

`graph`, `stream`, `actor` and `timed`, through `combine`. A join never runs on `linear`. The registry test runs the examples on all four flagged paths and checks the linear rejection.

## Determinism

Only integer absolute differences and comparisons are used, with no rounding and no arithmetic profile. The Linux reference is built with x86 assembly disabled, so native runs the C `maskedmin8`/`maskedmax8` path. Native slices split rows independently. The default thread count and `-filter_threads 1` give the same bytes, and the graph test checks this. Every case runs on every platform, and none is gated to Linux.

## Evidence

`tests/differential/video-maskedminmax.test.ts` runs `.build/reference/ffmpeg` at test time. It first checks `.build/reference/build-metadata.json`: commit `946fcce0` and `--disable-x86asm`. It does not pin a binary hash. The inputs mix ramps, LCG noise, 0/255 extremes, exact ties (`|s-f1| == |s-f2|` with `f1 != f2`), equal filters, filters equal to the source, and constant planes. The runs used Node 24.22.3 in the sandbox on linux-x64, with a reference ffmpeg of sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c` built by `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.

| Test title | Path | Comparisons |
|---|---|---|
| `matches native maskedmin and maskedmax on three distinct inputs across formats, sizes, plane masks and ties` | stream (multi-input CLI) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x (2 filters x planes {default, 0, 1, 6, 15} on mixed patterns + 2 filters on constant planes), 3 frames, rawvideo or framecrc: 432 |
| `matches native maskedmin and maskedmax split=3 graphs on the graph path, with implicit conversions, -ss/-t and both thread settings` | graph (single-input `-filter_complex`) | 9 sources (the six formats plus nv12, rgb24 and nv21 through conversion with `-cpuflags 0`) x 3 split=3 graphs x {none, `-ss 0.04 -t 0.05`} x {rawvideo, framecrc}: 108 byte matches, each also equal to native with `-filter_threads 1` |
| `matches native maskedmin and maskedmax on the stream path through replay execution and unequal-length multi-input CLI runs` | stream | 4 formats x (3 `createReplayVideoExecution` graphs with one or three sources + 3 unequal-length triples {3,2,4}, {1,3,2}, {4,4,1} x {rawvideo, framecrc}): 36 |
| `matches native maskedmin and maskedmax through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer`), timed (`pull`) | 4 formats x 2 schedulers x 2 muxers x (2 split graphs x {none, `-ss/-t`} + 2 three-input unequal-length {3,2,4} runs): 96 |
| `refuses maskedmin and maskedmax size mismatches, framesync options, out-of-range planes and enable= before opening any output on every path` | graph/stream, actor, timed | 10 cases x 3 backends: 30. Native status is EINVAL for the 3 size mismatches, 8 for `shortest`, `eof_action`, `repeatlast` and `ts_sync_mode`, ERANGE for `planes=16` and `planes=-1`, and 0 for `enable=`, which is refused here. EdgeFFmpeg exits non-zero with zero outputs opened and the named message |
| `negotiates every executable source as native does and refuses the packed-alpha gbrap picks before output on every join path` | graph, stream, actor, timed | native's pick is read with showinfo from 14 sources. 10 run byte-exact on the four paths; argb, rgba, abgr and bgra pick `gbrap` and are refused by name with no output opened. 56 checks |

Three mutations of the kernel were each caught by this file: `<=`/`>=` tie handling (4 tests failed), ignoring the plane mask (4 failed) and swapping min and max (5 failed).

`tests/differential/video-maskedminmax.test.ts` keeps its own per-source negotiation test. `tests/helpers/video-negotiation-cases.ts` always runs the linear path, which a join cannot take. The helper was not edited. The new test follows its method on the four join paths.

`tests/unit/video-maskedminmax.test.ts` covers:

- parsing: defaults, shorthand, expressions, rounding, the range, unknown and framesync options, and `enable=`;
- the selection rule with ties, the plane masks, owned tight output planes and an unmutated padded input;
- timestamps across time bases, the `INT64_MIN` clamp, null timestamps and metadata;
- every geometry and `combine` refusal, `maxFrameBytes`, malformed strides and `AbortSignal`;
- the linear rejection, graph negotiation from nv12, the size refusal at plan time, refused runtime commands and an actor run.

## Unsupported scope

- High-bit-depth (9 to 16 bit) and float formats, `yuv440p`, `yuv411p`, `yuv410p`, `yuvj*`, `yuva422p`, `yuva444p` and `gbrap` have no frame storage here. Any negotiation that picks one is refused by name. This includes packed RGB with alpha inputs, which negotiate `gbrap`.
- `enable=` timelines and runtime commands.
- CLI exit statuses: EdgeFFmpeg exits with 1 where native exits with EINVAL, ERANGE or 8.

## Proposed test contracts

| Id | File | Test title | Modes | Scope |
|---|---|---|---|---|
| `filter.maskedmin.inputs` | `tests/differential/video-maskedminmax.test.ts` | `matches native maskedmin and maskedmax on three distinct inputs across formats, sizes, plane masks and ties` | stream | six eight-bit formats, six sizes, plane masks, ties and constant planes, three distinct inputs |
| `filter.maskedmin.graph` | `tests/differential/video-maskedminmax.test.ts` | `matches native maskedmin and maskedmax split=3 graphs on the graph path, with implicit conversions, -ss/-t and both thread settings` | graph | split=3 graphs, nv12/nv21/rgb24 conversions, `-ss/-t`, rawvideo and framecrc, `-filter_threads 1` |
| `filter.maskedmin.stream` | `tests/differential/video-maskedminmax.test.ts` | `matches native maskedmin and maskedmax on the stream path through replay execution and unequal-length multi-input CLI runs` | stream | replay execution and unequal-length multi-input CLI |
| `filter.maskedmin.timed` | `tests/differential/video-maskedminmax.test.ts` | `matches native maskedmin and maskedmax through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor, timed | timed backend `producer` and `pull` schedulers, split and three-input graphs |
| `filter.maskedmin.reject` | `tests/differential/video-maskedminmax.test.ts` | `refuses maskedmin and maskedmax size mismatches, framesync options, out-of-range planes and enable= before opening any output on every path` | graph, stream, actor, timed | refusals before output, with native's status recorded |
| `filter.maskedmin.negotiation` | `tests/differential/video-maskedminmax.test.ts` | `negotiates every executable source as native does and refuses the packed-alpha gbrap picks before output on every join path` | graph, stream, actor, timed | native picks from 14 sources, with gbrap refused by name |

All six contracts run on every platform.
