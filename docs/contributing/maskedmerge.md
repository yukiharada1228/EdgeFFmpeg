# maskedmerge video filter

`maskedmerge` merges its first input (`base`) with its second input (`overlay`), weighting each sample by the matching sample of its third input (`mask`). It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_maskedmerge.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance is in `packages/avfilter/NOTICE-MASKEDMERGE`; the descriptor is `packages/avfilter/src/video-ops/maskedmerge.ts`.

## Syntax

`[base][overlay][mask]maskedmerge[=planes]`, or the named option `planes`. Later occurrences win.

| Option | Type | Range | Default |
|---|---|---|---|
| `planes` | `AV_OPT_TYPE_INT` (plane bit mask) | 0..15 | 15 |

The value is parsed by the shared AV_OPT_TYPE_INT adaptation (`filterIntegerOption`): expressions, hexadecimal, the `default`, `min`, `max`, `none` and `all` constants, round half to even. A value outside the range fails with `Invalid maskedmerge planes: ...` (native: ERANGE, exit 222 on Linux).

Native declares no framesync options for maskedmerge (`AVFILTER_DEFINE_CLASS`, not `FRAMESYNC_DEFINE_CLASS`), so `shortest`, `eof_action`, `repeatlast` and `ts_sync_mode` are unknown options natively (`Option not found`, exit 8). They fail here with `Unsupported maskedmerge option`. The descriptor's join `shortest` field is therefore always `false`. This differs from the [FS-OPTS] note in the wave spec, which assumed framesync options; native has none to accept.

## Arithmetic

For every selected plane (bit `p` of `planes` set), each sample is the pinned `MASKEDMERGE(8, uint8_t, uint16_t, 127, 255, / 255)` template:

```
out = (b * (255 - m) + m * o + 127) / 255     (integer division)
```

The largest intermediate value is 255 * 255 + 127 = 65152, so the `uint16_t` casts never wrap. A plane whose bit is not set is copied from `base`. Bits with no plane are ignored. For gbrp the bits follow the plane index (G=1, B=2, R=4). The wave spec wrote this as `(b*(255-m) + m*o + 128) >> 8`. The native template uses `+ 127` and `/ 255`, and the differential tests confirm the template: a `+ 128` mutation fails five of the eight differential tests.

The output takes its size, sample aspect ratio, frame rate and props (metadata) from `base`. Its timestamp is the framesync event's, rescaled without `AV_ROUND_PASS_MINMAX`, so INT64_MIN becomes INT64_MIN+1, as in vf_stack.

## Synchronization

Role `join` with three pads. Native configures every pad `sync=1`, `before=EXT_STOP`, `after=EXT_INFINITY`. That is the vf_stack configuration the shared join engines implement, with `shortest` off. Inputs of unequal length repeat their last frame until the longest input ends. This is tested on every flagged path.

## Formats and geometry

`formats()` returns the native `pix_fmts` list in declared order (61 formats, native-endian names, `yuvj` and float included), shared by all three pads as `ff_set_common_formats` does. Frames run in the six eight-bit layouts with storage: `gray`, `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p`, `gbrp`. Other picks are refused by name by the shared negotiators. The per-source negotiation test pins the picks: nv12 and nv21 go to yuv420p, rgb24 and bgr24 go to gbrp, and argb, rgba, abgr and bgra are refused because native picks `gbrap`.

`geometry()` refuses inputs whose sizes differ (`Maskedmerge input sizes differ: base WxH, overlay WxH, mask WxH`). Native fails in `config_output` with EINVAL, exit 234 on Linux. Inputs whose formats differ after negotiation, and input counts other than three, are refused too. `combine` repeats every check.

## Refused forms

- `enable=`: `Maskedmerge timeline expressions are not implemented`. Native supports the timeline internally (`AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL`).
- Runtime commands (`planes`, `enable`): the descriptor sets neither `timeline` nor `geometryCommands`, so the actors answer with the unsupported code.
- Framesync options and any unknown option: `Unsupported maskedmerge option`.
- Frames in unsupported formats, malformed planes or strides, over-budget frames (`maxFrameBytes`), invalid time bases and unsynchronized timestamps fail explicitly. `AbortSignal` is checked before work and on every row.

## Paths

`graph`, `stream`, `actor` and `timed`. A join is never linear. On the linear path the registry test checks that it is rejected.

## Determinism

Integer only, with no arithmetic profile. The reference is built with `--disable-x86asm`, so native runs the C `maskedmerge8`. Native slices are independent row ranges: default threads and `-filter_threads 1` agree (tested). Every case runs on every platform. No case is gated to linux-x64.

## Evidence

`tests/differential/video-maskedmerge.test.ts` runs `.build/reference/ffmpeg` at test time and asserts that `build-metadata.json` names commit 946fcce0 and `--disable-x86asm`. It ran in a cloud sandbox (linux x64) against a sandbox build of the reference, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, compiler `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node 24.22.3. That build is not the pinned binary. The inputs are LCG noise with ramps and 0/255 extremes; masks are constant 0, 128 and 255, a ramp, a ramp with hard edges, and noise.

| Test title | Path | Comparisons |
|---|---|---|
| `runs against the sandbox reference built from commit 946fcce0 with --disable-x86asm` | – | reference metadata |
| `matches native maskedmerge rawvideo across formats, sizes, masks and planes 1, 7 and 15 on the graph path` | graph (`compileMultiInputVideoFilterGraph`) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 6 masks x planes {1, 7, 15}, 3 distinct inputs of 3 frames each: 648 three-frame rawvideo matches; inputs not mutated |
| `matches native maskedmerge CLI rawvideo and framecrc on the graph and stream paths, with -ss, -t and unequal lengths` | graph (split=3 single input, media `-filter_complex`), stream (three-input CLI) | 6 format/size pairs x 5 graphs (split=3 with hflip/vflip, split=3 with input -ss and output -t, three inputs of lengths 3/2/4, reordered pads with -t, input -ss) x {rawvideo, framecrc}: 60 |
| `matches native maskedmerge on the stream path through replay execution with three distinct sources of unequal length` | stream (`createReplayVideoExecution`) | 3 formats x lengths {3/3/3, 3/1/2, 1/3/2} x planes {1, 7, 15}: 27, timestamps included |
| `matches native maskedmerge through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor (`producer`), timed (`pull`) | 4 formats x 3 graphs (split=3, three inputs of lengths 3/2/4, reordered) x 2 muxers x 2 schedulers: 48 |
| `agrees with native maskedmerge under default threads and -filter_threads 1` | native only | 6 |
| `fails like native for maskedmerge size mismatches and refused options before opening any output on every path` | media (graph/stream), actor, timed | 7 refusals (2 size mismatches, shortest, eof_action, repeatlast, ts_sync_mode, planes=16) x 3 backends: 21. Native statuses pinned at 234, 8 and 222. EdgeFFmpeg exits non-zero without opening an output |
| `negotiates every source as native does on the join paths and refuses picks without storage by name before output` | graph, stream, actor, timed, CLI | 14 sources, native pick read from showinfo: 10 byte-exact on 4 paths (40); 4 packed-alpha sources refused naming `gbrap` on 4 paths and 3 CLI backends (28): 68 |

`tests/unit/video-maskedmerge.test.ts` (5 tests) covers parsing and every refusal, the format list, geometry refusals, hand-computed arithmetic including the rounding edges, the plane mask, owned output planes, inputs not mutated, `maxFrameBytes`, malformed strides, unsynchronized timestamps, AbortSignal, linear rejection, plan-time size refusals and runtime-command refusal. The descriptor's four examples run on every flagged path in `tests/unit/video-operator-registry.test.ts`.

## Proposed contracts

| id | File | Test title | Scope |
|---|---|---|---|
| `filter.maskedmerge.kernel` | `tests/differential/video-maskedmerge.test.ts` | `matches native maskedmerge rawvideo across formats, sizes, masks and planes 1, 7 and 15 on the graph path` | 8-bit formats, sizes, masks, planes |
| `filter.maskedmerge.cli` | `tests/differential/video-maskedmerge.test.ts` | `matches native maskedmerge CLI rawvideo and framecrc on the graph and stream paths, with -ss, -t and unequal lengths` | graph and stream CLI |
| `filter.maskedmerge.stream` | `tests/differential/video-maskedmerge.test.ts` | `matches native maskedmerge on the stream path through replay execution with three distinct sources of unequal length` | replay stream sync |
| `filter.maskedmerge.timed` | `tests/differential/video-maskedmerge.test.ts` | `matches native maskedmerge through the timed backend on the actor and timed paths in rawvideo and framecrc` | actor and timed |
| `filter.maskedmerge.threads` | `tests/differential/video-maskedmerge.test.ts` | `agrees with native maskedmerge under default threads and -filter_threads 1` | native thread independence |
| `filter.maskedmerge.refusals` | `tests/differential/video-maskedmerge.test.ts` | `fails like native for maskedmerge size mismatches and refused options before opening any output on every path` | refusals |
| `filter.maskedmerge.negotiation` | `tests/differential/video-maskedmerge.test.ts` | `negotiates every source as native does on the join paths and refuses picks without storage by name before output` | per-source negotiation |

Every contract covers all platforms. None is gated.

## Unsupported scope

- Formats with more than 8 bits, float formats, `yuv440p`, `yuv411p`, `yuv410p`, `yuvj440p`, `yuvj411p`, `yuva422p`, `yuva444p`, `gbrap` and the other formats without frame storage. A negotiation that picks one is refused by name, including packed RGB with alpha, which goes to `gbrap`.
- `enable=` timelines and runtime commands.
- The linear path, because a join takes three inputs.

## Shared edits

Only the registry lines in `packages/avfilter/src/video-ops/registry.ts` (+1 import, +1 entry). `tests/helpers/video-negotiation-cases.ts` always runs a linear chain, which a join cannot. The negotiation test therefore keeps its own join form in this operator's differential file. A join-aware option for that helper would let later join operators share it.
