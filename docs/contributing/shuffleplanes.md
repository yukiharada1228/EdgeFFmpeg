# shuffleplanes

`shuffleplanes` remaps the planes of a frame: output plane `i` is input plane `map[i]`. It is a scoped adaptation of pinned FFmpeg 9.0.2 `libavfilter/vf_shuffleplanes.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Provenance: `packages/avfilter/NOTICE-SHUFFLEPLANES`.

## Syntax

`shuffleplanes[=map0:map1:map2:map3]`, or named `map0`..`map3`, each defaulting to 0, 1, 2 and 3. Values are the decimal digits `0` to `3`.

Refused before any output is opened:

- `enable=` (no timeline) and runtime commands (refused automatically: no `timeline`, no `geometryCommands`);
- values other than a single decimal digit 0..3 (native also accepts expressions such as `1+0` and hex); unknown options, including the generic `threads`;
- tuples for which no negotiation-table format qualifies (163 of the 256 tuples, for example `3:3:3:3` or `1:0:0:0`). Native accepts these with formats outside the table (gbrap, yuva444p and others).

## Formats

`formats(step)` reproduces native `query_formats` over the 14-format negotiation table, in table order: every `map[i]` (all four, whatever the plane count) must be below the format's plane count, and subsampled formats (yuv420p, yuv422p, nv12, nv21, yuva420p) must keep output planes 1 and 2 mapped within {1,2} and planes 0 and 3 outside it. With the defaults only yuva420p qualifies; `0:0:0:0` admits the packed and single-plane formats plus yuv444p and gbrp; nv12/nv21 need `0:1:1:0`. `validate` and `frame` repeat the check against the negotiated format. Because accepted formats only pair planes of equal geometry, the frame function is a pure row copy; duplicated maps produce independent copies, as native `av_frame_copy` does.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are flagged. Role `frame`; actor and timed call `frame` directly.

## Determinism

Pure byte copy: no arithmetic profile involved. Implicit conversions around the filter use the swscale paths of the surrounding chain; the differential tests run native with `-cpuflags 0` and the scalar arithmetic whenever a conversion is possible.

## Evidence (tests/differential/video-shuffleplanes.test.ts, native Linux x86_64 reference)

| Test | Native comparisons |
|---|---|
| matches native shuffleplanes query_formats for every map tuple over the negotiation table | 3584 (256 tuples x 14 formats): native inserts no auto_scale exactly when the format is in `formats(step)` (195 direct, 3389 converted, 163 tuples refused here) |
| matches native shuffleplanes plane copies for every accepted map tuple and table format | 780 rawvideo frames, every accepted tuple x format x 1x1/5x3/6x4/17x9 |
| matches native linear shuffleplanes chains with negotiated table conversions | 1568 chains (14 sources x 14 tuples x 2 chains x 4 output formats): 802 byte-equal where native negotiates a table format, 766 where native lands outside the table (asserted to differ in format, see below) |
| matches native shuffleplanes CLI rawvideo and framecrc through -vf and -filter_complex | 320 |
| matches native replayed shuffleplanes branches and joins frame by frame | 30 |
| matches native shuffleplanes framecrc and rawvideo through the actor and timed schedulers | 240 (`pull`, `activation`, `producer`) |
| refuses shuffleplanes timelines, unimplemented values and empty mappings before opening CLI outputs | 16 (media and timed backends, -vf and -filter_complex) |

Unit tests (`tests/unit/video-shuffleplanes.test.ts`, 5 tests) cover parsing, every one of the 256 per-step format lists against the native rule recomputed from `pixelLayout`, plane remapping and duplication, budgets, malformed strides, AbortSignal, the unmutated input and the planners.

## Unsupported

- **Native negotiation outside the table.** When the input format is not accepted, native frequently converts to a format the shared negotiation table lacks (gbrap for gray/RGB/gbrp input with the defaults, yuva444p for yuv444p, yuvj444p for gray with `0:1:1:0`). This implementation converts to a table format instead, so those chains produce a different format and bytes. Only chains whose native negotiation stays inside the table (the input is accepted directly, or for example yuv420p/nv12/nv21 to yuva420p) are claimed. Closing the gap needs new table formats in `video-ops/formats.ts`, a shared edit outside this operator's scope.
- Expression and hex option values, `enable=`, runtime commands and tuples with no table format.

## Scoped test contracts

| Id | File | Test | Scope |
|---|---|---|---|
| filter.shuffleplanes.formats | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes query_formats for every map tuple over the negotiation table | format rule |
| filter.shuffleplanes.kernel | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes plane copies for every accepted map tuple and table format | frame copy |
| filter.shuffleplanes.linear | tests/differential/video-shuffleplanes.test.ts | matches native linear shuffleplanes chains with negotiated table conversions | linear |
| filter.shuffleplanes.cli | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes CLI rawvideo and framecrc through -vf and -filter_complex | linear, graph |
| filter.shuffleplanes.stream | tests/differential/video-shuffleplanes.test.ts | matches native replayed shuffleplanes branches and joins frame by frame | stream |
| filter.shuffleplanes.timed | tests/differential/video-shuffleplanes.test.ts | matches native shuffleplanes framecrc and rawvideo through the actor and timed schedulers | actor, timed |
| filter.shuffleplanes.refusals | tests/differential/video-shuffleplanes.test.ts | refuses shuffleplanes timelines, unimplemented values and empty mappings before opening CLI outputs | refusals |
