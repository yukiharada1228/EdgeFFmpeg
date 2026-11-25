# dilation video filter

`dilation` follows `dilation` and `filter_slice` in the pinned `libavfilter/vf_neighbor.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Each output sample is the maximum of the input sample and the neighbours selected by `coordinates`, clamped to `min(p + threshold, 255)`. The descriptor in `packages/avfilter/src/video-ops/dilation.ts` keeps its own kernel. It shares no code with the erosion, deflate or inflate branches. Provenance is in `packages/avfilter/NOTICE-DILATION`.

## Syntax

`dilation[=coordinates[:threshold0[:threshold1[:threshold2[:threshold3]]]]]`, or the same names as `key=value` pairs.

| Option | Range | Default | Meaning |
|---|---|---|---|
| `coordinates` | 0..255 | 255 | Neighbour mask. Bit 0 is top-left, then top, top-right, left, right, bottom-left, bottom and bottom-right (bit 7). |
| `threshold0`..`threshold3` | 0..65535 | 65535 | Per-plane maximum increase. `0` copies the plane unchanged. |

Values are parsed as `AV_OPT_TYPE_INT`: expressions with the constants `default`, `min`, `max`, `none` and `all`, range checked, with ties rounded to even (`filterIntegerOption`, linux-x64 profile).

The following are refused before any output is opened:

- out-of-range or invalid values;
- `enable=` (`Dilation timeline expressions are not implemented`);
- every other option, including `threads`;
- more than five positional values.

Runtime commands are refused, because the descriptor sets neither `timeline` nor `geometryCommands`. `threshold*`, `coordinates` and `w` return ENOSYS, and `enable` returns `AVERROR_PATCHWELCOME`. Native would accept `threshold*` and `coordinates`.

## Formats and geometry

`formats()` returns the native `vf_neighbor.c` `pix_fmts` in declared order (57 formats: planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included), so the shared negotiators pick exactly what native picks. Frames run in the eight-bit layouts with frame storage, yuv420p, yuv422p, yuv444p, gray, yuva420p and gbrp, and in the legacy yuvj420p/yuvj422p/yuvj444p sources of linear chains. Other sources are converted automatically, as in native: nv12/nv21 to yuv420p, rgb24/bgr24 to gbrp. Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively, which has no frame storage here: the negotiators refuse it at plan time with `Video filter dilation input negotiates gbrap, which is not implemented`, on every path and before any output is opened.

Border semantics follow native exactly:

- Columns: column 0 uses the `coordinateslb` table (left/top-left/bottom-left reflect to column 1), and the last column uses `coordinatesrb` (right reflects to `width-2`).
- Rows: the first and last rows clamp to themselves through `nh`/`ph`. Height-1 planes are therefore valid.

`geometry()` keeps the size, but refuses any negotiated plane narrower than 2 pixels (`Dilation planes narrower than 2 pixels are not implemented`). Native reads past the row in `coordinateslb` there. Examples: gray width 1, yuv420p/yuva420p width 2 (chroma width 1), yuv422p width 1. `frame()` repeats the check for frames reconfigured on the actor path.

`frame()` returns owned, tight, positive-stride planes. It checks `maxFrameBytes` for the output and for the resident input storage, rejects malformed strides, plane counts and time bases, checks `AbortSignal` per row, preserves the bigint PTS and metadata, and never mutates its input.

## Paths

All five paths are flagged: `linear`, `graph`, `stream`, `actor` and `timed`. `dilation` is a stateless `frame` operator, so the actor and timed executors call `frame` directly.

## Determinism

Integer max/min only, with no floating point in the kernel. The output does not depend on the platform or the slice threading.

## Evidence

Every comparison runs `.build/reference/ffmpeg` (Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`) at test time; after the shared negotiation fix every test was rerun on macOS arm64 against the pinned reference (sha256 `1b86106f…ab92`). `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` runs `dilation=coordinates=90:threshold0=12` from 17 sources (the 14 executable formats and yuvj420p/422p/444p) with native's pick read from showinfo: 13 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains), and argb, rgba, abgr and bgra are refused naming `gbrap` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened (89 checks). The other tests have three or four frames per input:

- LCG noise;
- sparse near-saturated peaks over a ramp;
- a saturated checkerboard.

| Test (tests/differential/video-dilation.test.ts) | Native comparisons |
|---|---|
| `matches native dilation bytes across formats coordinates thresholds edge sizes and patterns` | 741 rawvideo runs: 6 formats x 8 sizes (2x1 to 17x9) x 19 option sets, each with 3 frames. Also 171 width-1 refusals. |
| `matches native linear dilation chains with negotiated conversion and scalar or default arithmetic` | 540 `compileVideoFilterChain` runs: 9 sources x 2 sizes x 3 targets x 5 chains x {default, `-cpuflags 0` scalar} |
| `matches native dilation CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes` | 288 `-vf` and 48 two-output `-filter_complex` CLI runs, rawvideo and framecrc |
| `matches native replayed dilation branches and joins frame by frame` | 20 `createReplayVideoExecution` runs |
| `matches native dilation framecrc and rawvideo through the timed executor and activation actors` | 432 timed-backend runs: 144 native runs x {`pull` (timed DAG executor), `activation`, `producer` (actors)} |
| `refuses width-1 dilation planes on every path before opening outputs` | 25 refusals on linear, CLI `-vf`/`-filter_complex` and the three timed schedulers, with no output opened. Also 1 native run showing that native accepts the size. |

Unit tests (`tests/unit/video-dilation.test.ts`, 4 tests) cover:

- parsing, ranges and refusals;
- every border table bit;
- threshold limits and threshold-0 copies;
- unmutated padded input;
- budgets, malformed strides, plane counts and time bases;
- AbortSignal;
- planner refusals on linear, graph and actor;
- runtime command refusals.

`tests/unit/video-operator-registry.test.ts` runs the three descriptor examples on all five paths.

## Scoped test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/video-dilation.test.ts | matches native dilation bytes across formats coordinates thresholds edge sizes and patterns | kernel |
| tests/differential/video-dilation.test.ts | matches native linear dilation chains with negotiated conversion and scalar or default arithmetic | linear |
| tests/differential/video-dilation.test.ts | matches native dilation CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes | linear, graph |
| tests/differential/video-dilation.test.ts | matches native replayed dilation branches and joins frame by frame | stream |
| tests/differential/video-dilation.test.ts | matches native dilation framecrc and rawvideo through the timed executor and activation actors | actor, timed |
| tests/differential/video-dilation.test.ts | refuses width-1 dilation planes on every path before opening outputs | refusals |
| tests/differential/video-dilation.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | negotiation, every path |

## Unsupported

- Native high-bit-depth formats (9-16 bit YUV, GBR(A)P, gray) and yuva422p/yuva444p/yuv440p/yuv411p/yuv410p/gbrap/yuvj440p/yuvj411p have no frame storage here; a negotiation that picks one is refused by name.
- **Packed RGB sources with alpha (rgba, bgra, argb, abgr).** Native negotiates `gbrap`; refused before output (see Formats). Before the shared negotiation fix these silently picked a table format and diverged.
- Width-1 planes, which native mishandles by reading past the row.
- `enable=` timelines, and runtime `threshold*`/`coordinates` commands.
