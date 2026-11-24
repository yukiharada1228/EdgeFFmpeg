# inflate video filter

`inflate` follows the pinned `libavfilter/vf_neighbor.c` (the `deflate_inflate`
class) at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. The descriptor
`packages/avfilter/src/video-ops/inflate.ts` registers it as a `frame` operator on
all five paths: `linear`, `graph`, `stream`, `actor` and `timed`. Provenance is in
`packages/avfilter/NOTICE-INFLATE`.

## Kernel

For every pixel `p` of a plane whose threshold `t` is nonzero:

```
dst = min(max(sum8 / 8, p), min(p + t, 255))
```

`sum8` is the integer sum of the eight neighbours. The borders follow the native
tables exactly:

- The row above the first row and the row below the last row are the row itself (`nh`/`ph`).
- At `x = 0` the left neighbour column is `1` (`coordinateslb`).
- At `x = width - 1` both the left and right neighbour columns are `width - 2` (`coordinatesrb`).

A plane whose threshold is 0 is copied unchanged (`av_image_copy_plane`). The
arithmetic is integer only, with no platform-dependent path. `inflateVideoFrame`
returns owned tight positive-stride planes and keeps the bigint PTS and metadata.
It checks `maxFrameBytes`, the resident input storage, the plane count, the strides,
the time base and the `AbortSignal` (per row, and every 16384 pixels). It never
mutates its input.

## Syntax

`threshold0`, `threshold1`, `threshold2` and `threshold3`, in that shorthand order
(`inflate=1:2:3:4`). They are `AV_OPT_TYPE_INT` in `[0, 65535]` with default 65535,
parsed as native does: av_expr expressions with the `default`, `max`, `min`, `none`
and `all` constants, a range check, then nearest-even rounding (`2.5` -> `2`). The
threshold of plane `i` applies to the native plane order (Y/U/V/A, or G/B/R for gbrp).

## Formats

The native `pix_fmts` intersected with the shared negotiation table, in table
order: `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p`, `gbrp`. Other sources
are converted automatically, as native negotiation does. For example, rgb24 and
bgr24 become gbrp, and nv12 and nv21 become yuv420p.

## Refused forms

All of these fail before any output is opened:

- **Unknown options** (`coordinates`, `threshold4`, `bogus`, extra positional values) fail with native wording: `Error applying option '<key>' to filter 'inflate': Option not found`, or `Missing filter option name` where native reports `No option name near`.
- **Out-of-range thresholds** fail with `... Numerical result out of range`. Non-numeric thresholds fail with an `Error applying option '<key>' to filter 'inflate'` message. For `nan`, ours ends in `Numerical result out of range` where native's ends in `Invalid argument`; the test checks only the shared prefix.
- **`enable=`** timeline expressions and the generic context options `threads`, `thread_type` and `extra_hw_frames` are refused as not implemented. Native accepts them. Runtime commands (`sendcmd`, `process_command`) are refused, because the descriptor sets neither `timeline` nor `geometryCommands`.
- **Filtered width-1 planes.** A plane narrower than two pixels whose threshold is nonzero is refused with `Inflate needs filtered planes at least two pixels wide`, from `geometry` on every path and again in `frame`. Native reads past the row there (`coordinateslb` at `src + 1`). Examples are gray width 1, and yuv420p, yuv422p or yuva420p width 2 with a nonzero chroma threshold. Width-1 planes whose threshold is 0 are copied, and that is verified against native.

## Known divergence (not refused)

Packed RGB sources with alpha (`rgba`, `bgra`, `argb`, `abgr`) diverge when inflate's
negotiation group does not merge with a declared table format. One example is
`hflip,inflate,scale=13:7` from rgba. Native then negotiates `gbrap` for inflate's
input, and `gbrap` is not in the shared negotiation table, so the output differs.
Fixing this needs `gbrap` added to the shared `video-ops/formats.ts`, which is a
shared edit outside this branch. Sources with alpha in the table (`yuva420p`) are
unaffected. The committed tests use no packed-alpha RGB source.

## Evidence

All comparisons run the locally built `.build/reference/ffmpeg` (Linux x86_64) at
test time, with `-cpuflags 0` where conversions occur and scalar arithmetic on our
side. They are in `tests/differential/video-inflate.test.ts`:

| Test | Native comparisons |
|---|---|
| `matches native inflate kernels across formats, sizes, thresholds, patterns and borders` | 264 rawvideo comparisons (6 frames each): 6 formats; sizes 2x1, 3x1, 4x3, 7x5, 17x9, 2x6 and 1x4; 8 threshold sets (default, 0, per-plane, expressions and rounding, 65535); noise, ramp, checker, impulse and saturated patterns |
| `matches native inflate CLI rawvideo and framecrc outputs across conversions and timing` | 112 linear `-vf` runs through the public frontend: rawvideo and framecrc outputs, with `-ss`/`-frames:v`, scale chains and conversions from gbrp, yuva420p, nv12, gray, bgr24 and yuv422p |
| `matches native complex inflate graphs on the frame-graph path` | 24 `-filter_complex` runs with two outputs each (48 comparisons), rawvideo and framecrc |
| `matches native replayed inflate streams frame by frame` | 18 `createReplayVideoExecution` runs, including an hstack join |
| `matches native inflate through the timed backend actor and pull schedulers` | 48 timed-backend runs (`producer` and `activation` actor schedulers, and the `pull` timed executor), rawvideo and framecrc, against 16 native outputs |
| `fails like native for unknown and out-of-range inflate options and refuses filtered width-1 planes before opening outputs` | 11 cases. Native's stderr is checked for 7 of them, and native's success for the 4 that are refused only by scope. Each case runs on linear, graph, actor and timed, with no output opened |

Unit tests are in `tests/unit/video-inflate.test.ts` (8 tests). They cover parsing,
refusals, the descriptor contract, a transcription of the native kernel, per-plane
thresholds, budgets, malformed strides, AbortSignal and an unmutated input. The
unchanged `tests/unit/video-operator-registry.test.ts` checks that all five paths
give the same output for the examples `inflate`, `inflate=threshold0=12:threshold1=0`
and `inflate=7,hflip`.

## Proposed test contracts

| id | file | test title | modes |
|---|---|---|---|
| `filter.inflate.kernel` | tests/differential/video-inflate.test.ts | matches native inflate kernels across formats, sizes, thresholds, patterns and borders | linear |
| `filter.inflate.cli` | tests/differential/video-inflate.test.ts | matches native inflate CLI rawvideo and framecrc outputs across conversions and timing | linear |
| `filter.inflate.graph` | tests/differential/video-inflate.test.ts | matches native complex inflate graphs on the frame-graph path | graph |
| `filter.inflate.stream` | tests/differential/video-inflate.test.ts | matches native replayed inflate streams frame by frame | stream |
| `filter.inflate.timed` | tests/differential/video-inflate.test.ts | matches native inflate through the timed backend actor and pull schedulers | actor, timed |
| `filter.inflate.refusals` | tests/differential/video-inflate.test.ts | fails like native for unknown and out-of-range inflate options and refuses filtered width-1 planes before opening outputs | linear, graph, actor, timed |

## Unsupported

- **Formats.** High-bit-depth formats (`inflate16`) and yuv440p, yuv411p, yuv410p, yuvj*, yuva422p/444p and gbrap are not in the shared table, and rawvideo refuses them as input.
- **Options and timeline.** `enable=`, the generic context options and runtime commands are refused.
- **Packed-alpha RGB divergence.** See [Known divergence](#known-divergence-not-refused).
- **H.264/MP4 framecrc.** Not compared. Inflate keeps the size, so the aspect-ratio limit for size-changing operators does not apply.
