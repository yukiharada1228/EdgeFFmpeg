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

`formats()` is the native `vf_neighbor.c` `pix_fmts` list in declared order (57
formats: planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included), so the
shared negotiators pick exactly what native picks. Frames run in the eight-bit
layouts with frame storage, `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p`
and `gbrp`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear
chains. Other sources are converted automatically, as native negotiation does. For
example, rgb24 and bgr24 become gbrp, and nv12 and nv21 become yuv420p.

## Refused forms

All of these fail before any output is opened:

- **Unknown options** (`coordinates`, `threshold4`, `bogus`, extra positional values) fail with native wording: `Error applying option '<key>' to filter 'inflate': Option not found`, or `Missing filter option name` where native reports `No option name near`.
- **Out-of-range thresholds** fail with `... Numerical result out of range`. Native prints its host's `strerror(ERANGE)`: the same text on Linux, `Result too large` from the macOS reference; the test expects the host's text from native and glibc's from EdgeFFmpeg. Non-numeric thresholds fail with an `Error applying option '<key>' to filter 'inflate'` message. For `nan`, ours ends in `Numerical result out of range` where native's ends in `Invalid argument`; the test checks only the shared prefix.
- **`enable=`** timeline expressions and the generic context options `threads`, `thread_type` and `extra_hw_frames` are refused as not implemented. Native accepts them. Runtime commands (`sendcmd`, `process_command`) are refused, because the descriptor sets neither `timeline` nor `geometryCommands`.
- **Filtered width-1 planes.** A plane narrower than two pixels whose threshold is nonzero is refused with `Inflate needs filtered planes at least two pixels wide`, from `geometry` on every path and again in `frame`. Native reads past the row there (`coordinateslb` at `src + 1`). Examples are gray width 1, and yuv420p, yuv422p or yuva420p width 2 with a nonzero chroma threshold. Width-1 planes whose threshold is 0 are copied, and that is verified against native.

## Packed RGB with alpha (refused)

Native negotiates `gbrap` for inflate's input from packed RGB sources with alpha
(`rgba`, `bgra`, `argb`, `abgr`), for example in `inflate` or
`hflip,inflate,scale=13:7`. `gbrap` has no frame storage here, so the shared
negotiators refuse it at plan time with `Video filter inflate input negotiates
gbrap, which is not implemented`, on every path and before any output is opened.
Before the shared negotiation fix these chains silently negotiated a table format
and diverged. Sources with alpha that have storage (`yuva420p`) are unaffected.

## Evidence

All comparisons run the locally built `.build/reference/ffmpeg` (Linux x86_64) at
test time, with `-cpuflags 0` where conversions occur and scalar arithmetic on our
side; after the shared negotiation fix every test was rerun on macOS arm64 against
the pinned reference (sha256 `1b86106f…ab92`). They are in
`tests/differential/video-inflate.test.ts`. `negotiates every accepted source as
native does and refuses the packed-alpha gbrap picks before output on every path`
runs `inflate=threshold0=12:threshold1=0` from 17 sources (the 14 executable
formats and yuvj420p/422p/444p) with native's pick read from showinfo: 13 run
byte-exact on the five paths (yuvj on linear chains), and argb, rgba, abgr and
bgra are refused naming `gbrap` on the five paths and through the media
`-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened (89
checks).

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
| `filter.inflate.negotiation` | tests/differential/video-inflate.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | linear, graph, stream, actor, timed |

## Unsupported

- **Formats.** High-bit-depth formats (`inflate16`) and yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, yuva422p/444p and gbrap have no frame storage here: rawvideo refuses them as input, and a negotiation that picks one is refused by name.
- **Options and timeline.** `enable=`, the generic context options and runtime commands are refused.
- **Packed RGB with alpha.** Refused; see [Packed RGB with alpha](#packed-rgb-with-alpha-refused).
- **H.264/MP4 framecrc.** Not compared. Inflate keeps the size, so the aspect-ratio limit for size-changing operators does not apply.
