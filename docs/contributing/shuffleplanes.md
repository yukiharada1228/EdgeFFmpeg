# shuffleplanes

`shuffleplanes` remaps the planes of a frame: output plane `i` is input plane `map[i]`. It is a scoped adaptation of pinned FFmpeg 9.0.2 `libavfilter/vf_shuffleplanes.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance: `packages/avfilter/NOTICE-SHUFFLEPLANES`.

## Syntax

`shuffleplanes[=map0:map1:map2:map3]`, or named `map0`..`map3`, each defaulting to 0, 1, 2 and 3. Values are the decimal digits `0` to `3`.

Refused before any output is opened:

- `enable=` (no timeline) and runtime commands (refused automatically: no `timeline`, no `geometryCommands`);
- values other than a single decimal digit 0..3 (native also accepts expressions such as `1+0` and hex); unknown options, including the generic `threads`;
- any input whose native pick has no frame storage here (see Formats). Every tuple parses, as natively: four-plane formats admit every map. 163 tuples, for example `3:3:3:3` or `3:0:0:0`, admit no format with frame storage, so every input is refused by name.

## Formats

`formats(step)` reproduces native `query_formats` over every non-palette pixel format of the pinned build, in AVPixelFormat order: every `map[i]` (all four, whatever the plane count) must be below the format's plane count (`av_pix_fmt_count_planes`), and subsampled formats must keep output planes 1 and 2 mapped within {1,2} and planes 0 and 3 outside it. The plane counts and subsampling come from the pinned libavutil; all 256 lists (9,619 entries) were checked against a C helper linked against it. The shared negotiators therefore pick exactly what native picks, and refuse at plan time, with `Video filter shuffleplanes input negotiates <format>, which is not implemented`, every pick without frame storage here.

Frames run in the members with frame storage: with the defaults only yuva420p; `0:0:0:0` admits the packed and single-plane formats plus yuv444p and gbrp; nv12/nv21 need `0:1:1:0`. Legacy yuvj sources of linear chains also run. `validate` and `frame` repeat the check against the negotiated format. Because accepted formats only pair planes of equal geometry, the frame function is a pure row copy; duplicated maps produce independent copies, as native `av_frame_copy` does.

With the defaults native adds alpha: yuv420p, nv12 and nv21 convert to yuva420p and run; yuv422p and yuv444p convert to yuva422p and yuva444p, and gray, packed RGB and gbrp to gbrap, which are all refused. Before the shared negotiation fix those inputs silently picked another format.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are flagged. Role `frame`; actor and timed call `frame` directly.

## Determinism

Pure byte copy: no arithmetic profile involved. Implicit conversions around the filter use the swscale paths of the surrounding chain; the differential tests run native with `-cpuflags 0` and the scalar arithmetic whenever a conversion is possible.

## Evidence (tests/differential/video-shuffleplanes.test.ts)

Written against the native Linux x86_64 reference; after the shared negotiation fix every test ran on macOS arm64 against the pinned reference (sha256 `1b86106f…ab92`). The Linux x86_64 runs predate the re-land, which changed this operator's module and tests. The re-landed code, including the per-source negotiation test, has run only on macOS arm64.

| Test | Native comparisons |
|---|---|
| matches native shuffleplanes query_formats and picks for every map tuple, refusing picks without storage | 3584 (256 tuples x 14 formats): native inserts no auto_scale exactly when the format is in `formats(step)`, native's pick is in the list, and EdgeFFmpeg's linear negotiation picks it (195 direct, 510 converted) or refuses naming it (2879) |
| matches native shuffleplanes plane copies for every accepted map tuple and table format | 780 rawvideo frames, every accepted tuple x format x 1x1/5x3/6x4/17x9 |
| matches native linear shuffleplanes chains, refusing conversions into formats without storage by name | 1568 chains (14 sources x 14 tuples x 2 chains x 4 output formats): 802 byte-equal where native negotiates a format with storage, 766 refused naming native's format |
| matches native shuffleplanes CLI rawvideo and framecrc through -vf and -filter_complex | 320 |
| matches native replayed shuffleplanes branches and joins frame by frame | 30 |
| matches native shuffleplanes framecrc and rawvideo through the actor and timed schedulers | 240 (`pull`, `activation`, `producer`) |
| refuses shuffleplanes timelines, unimplemented values and picks without storage before opening CLI outputs | 16 (media and timed backends, -vf and -filter_complex); `3:3:3:3` on gray names native's `gbrap` |
| negotiates every accepted source as native does for three maps and refuses picks without storage before output on every path | the default map, `0:0:0:0` and `0:2:1:0` from 17 sources (the 14 executable formats and yuvj420p/422p/444p): 33 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains), 18 are refused naming native's pick on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened, except yuvj422p and yuvj444p with the default map, which are refused on linear chains only: 283 checks |

Unit tests (`tests/unit/video-shuffleplanes.test.ts`, 5 tests) cover parsing, every one of the 256 per-step format lists (AVPixelFormat order, 9,619 entries, members with frame storage against the native rule recomputed from `pixelLayout`), plane remapping and duplication, budgets, malformed strides, AbortSignal, the unmutated input and the planners.

## Unsupported

- **Native picks without frame storage.** When the input format is not accepted, native frequently converts to a format without frame storage here (gbrap for gray/RGB/gbrp input with the defaults, yuva444p for yuv444p, yuvj444p for gray with `0:2:1:0`). Those chains are refused at plan time naming native's format, on every path and before any output is opened.
- Expression and hex option values, `enable=` and runtime commands.

## Scoped test contracts

| Id | File | Test | Scope |
|---|---|---|---|
| filter.shuffleplanes.formats | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes query_formats and picks for every map tuple, refusing picks without storage | format rule, negotiation |
| filter.shuffleplanes.kernel | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes plane copies for every accepted map tuple and table format | frame copy |
| filter.shuffleplanes.linear | tests/differential/video-shuffleplanes.test.ts | matches native linear shuffleplanes chains, refusing conversions into formats without storage by name | linear |
| filter.shuffleplanes.cli | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes CLI rawvideo and framecrc through -vf and -filter_complex | linear, graph |
| filter.shuffleplanes.stream | tests/differential/video-shuffleplanes.test.ts | matches native replayed shuffleplanes branches and joins frame by frame | stream |
| filter.shuffleplanes.timed | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes framecrc and rawvideo through the actor and timed schedulers | actor, timed |
| filter.shuffleplanes.refusals | tests/differential/video-shuffleplanes.test.ts | refuses shuffleplanes timelines, unimplemented values and picks without storage before opening CLI outputs | refusals |
| filter.shuffleplanes.negotiation | tests/differential/video-shuffleplanes.test.ts | negotiates every accepted source as native does for three maps and refuses picks without storage before output on every path | linear, graph, stream, actor, timed, negotiation |
