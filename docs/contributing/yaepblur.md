# yaepblur video filter

`yaepblur` follows the pinned `libavfilter/vf_yaepblur.c` at
946fcce07b6dcd0331c8cc609192aeff5e1924f8. The descriptor
`packages/avfilter/src/video-ops/yaepblur.ts` registers it as a `frame` operator on
all five paths: `linear`, `graph`, `stream`, `actor` and `timed`. Provenance is in
`packages/avfilter/NOTICE-YAEPBLUR`.

## Kernel

For every pixel `src` of a selected plane, with the window clipped to the plane
(`lower = max(0, x - r)`, `higher = min(width, x + r + 1)`, the same for rows) and
`count` the window area:

```
mean = sum / count
var  = (square_sum - sum * sum / count) / count
dst  = (sigma * mean + var * src) / (sigma + var)
```

Every division is an unsigned integer division, as in native `filter_slice`
(`uint64_t`). `sum` and `square_sum` come from summed-area tables natively
(`pre_calculate_row`, then `pre_calculate_col`). Here each output row reads the
difference of the two table rows it needs, `sat[higher_y] - sat[lower_y]`, which is
the horizontal prefix of the column sums over `[lower_y, higher_y)`. The column
sums are kept as running sums, so the scratch is O(width) instead of two
`(w + 1) * (h + 1)` uint64 tables, and every window sum equals native's exactly.

Exactness of the 64-bit arithmetic:

- Every sum is an integer at most `65025 * w * h`, which is an exact double for every
  accepted plane.
- `sum * sum` uses doubles while `sum <= 94906265` (the product stays below 2^53). Larger
  sums use BigInt. The unit test runs that branch (an 801x700 plane at radius 350) and
  compares it with a literal BigInt port of the full native tables.
- Planes with `255 * w * h >= 2^32` (gray 4096x4113 and up) are refused in `geometry`
  and again in `frame`: native's `sum * sum` could wrap in uint64 there. Below that
  bound nothing wraps, and Cauchy-Schwarz keeps `square_sum - sum*sum/count`
  non-negative.
- `sigma * mean + var * src` is at most about `2^31 * 255 + 16256 * 255`, which is exact.

`config_input` clips the radius once, from the luma size, for every plane:
`radius = min(radius, AV_CEIL_RSHIFT(min(w, h), 1))`. A radius of 0, after the
option or the clip, and every plane whose bit in `planes` is clear are copied
unchanged. Plane bits follow the native plane order: Y/U/V/A, or G/B/R for gbrp.
`yaepblurVideoFrame` returns owned tight positive-stride planes and keeps the bigint
PTS and metadata. It checks `maxFrameBytes`, the resident input storage, the plane
count, the strides, the time base and the `AbortSignal` (per row, and every 16384
pixels). It never mutates its input. Native filters in place when the frame is
writable. That gives the same result, because each output pixel reads only its own
source sample after the tables are built.

## Syntax

| Option | Alias | Type | Range | Default |
|---|---|---|---|---|
| `radius` | `r` | INT | 0..INT_MAX | 3 |
| `planes` | `p` | INT | 0..0xF | 1 |
| `sigma` | `s` | INT | 1..INT_MAX | 128 |

Positional values follow the declared order with aliases skipped: `yaepblur=2:15:30`
is radius 2, planes 15, sigma 30. Values are parsed as native parses them: av_expr
expressions with the `default`, `max`, `min`, `none` and `all` constants, a range check,
then nearest-even rounding (`2.5` becomes `2`). An alias and its option write the same
field, and the last write wins.

## Formats

`formats()` is the native `pix_fmts` list in declared order: 57 formats, planar YUV,
YUVA, GBR(A)P and gray at every depth, `yuvj` included. The shared negotiators
therefore pick what native picks. Frames run in the eight-bit layouts that have frame
storage: `gray`, `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p` and `gbrp`. They also run
in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. Native picks
`gbrap` from the packed RGB sources with alpha (`argb`, `rgba`, `abgr`, `bgra`). That
format has no storage here, so every path refuses it by name at plan time (`Video
filter yaepblur input negotiates gbrap, which is not implemented`) before any output
opens.

## Refused forms

All of these fail before any output is opened:

- **Unknown options** (`bogus`, `rad`, extra positional values). They fail with native
  wording, `Error applying option '<key>' to filter 'yaepblur': Option not found`, or
  with `Missing filter option name` where native reports `No option name near`.
- **Out-of-range values** (`planes=16`, `p=-1`, `s=0`, `sigma=2147483648`, `r=-1`,
  `radius=2147483648`). They fail with `... Numerical result out of range`. Native
  prints its host's `strerror(ERANGE)`. The test expects the host's text from native
  and glibc's text from EdgeFFmpeg.
- **Non-numeric values.** They fail with the `Error applying option '<key>' to filter
  'yaepblur'` prefix.
- **`enable=`** timeline expressions and the generic context options `threads`,
  `thread_type` and `extra_hw_frames`. These are refused as not implemented, although
  native accepts them.
- **Runtime commands** (`sendcmd`, `process_command`). The descriptor sets neither
  `timeline` nor `geometryCommands`, so they are refused, although native's options
  are `AV_OPT_FLAG_RUNTIME_PARAM`. On the actor path `radius`, `r`, `planes` and `sigma`
  commands answer ENOSYS and `enable` answers AVERROR_PATCHWELCOME. Later frames keep
  the parsed options.
- **Planes of 2^32/255 samples or more.** See [Kernel](#kernel).

## Determinism

The arithmetic is integer only, with no platform-dependent path, so every case
runs on every platform. There are no linux-gated cases. Native slice threading
splits only rows and columns. The kernel test checks that native's default thread
count and `-filter_threads 1` give the same bytes in every case.

## Evidence

All comparisons run the locally built `.build/reference/ffmpeg` at test time. That
binary is the sandbox build at 946fcce0 with `--disable-x86asm`, asserted from
`.build/reference/build-metadata.json`:

- sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`
- `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`
- Linux x86_64, Node 24.22.3

Conversions run with `-cpuflags 0`, and our side uses scalar arithmetic. The
differential tests are in `tests/differential/video-yaepblur.test.ts`:

| Test | Native comparisons |
|---|---|
| kernels | 504 linear cases: 6 storage formats; sizes 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 and 64x48; 12 option sets (defaults, r=1, r=1000, s=1, s=2^31-1, p=7, p=15, r=0, positional, planes=6, p=0) over noise, ramps, checkers, impulses, saturated, constant and binary noise planes, 8 frames (2 at 64x48). Each also checks native default threads against `-filter_threads 1`. |
| CLI | 112 rawvideo and framecrc outputs: 7 source/target conversions, 4 chains, and runs with and without `-ss`/`-t` |
| frame graphs | 24 graphs with 48 outputs |
| replay streams | 18 |
| timed backend | 48 runs: producer, activation and pull schedulers; rawvideo and framecrc |
| rejections | 12 forms, checked against native status and message, then on media `-vf`, `-filter_complex` and timed producer/pull with no output opened |
| negotiation | 17 sources, 89 checks (13 matched on every path, 4 refused as gbrap) |

The unit tests (`tests/unit/video-yaepblur.test.ts`, 6 tests) cover parsing and every
refusal, the format list, geometry, hand-computed blends, plane selection, a literal
BigInt port of the native summed-area tables (7 random planes and the BigInt-range
plane), `maxFrameBytes`, malformed strides and storage, the `AbortSignal`, an
unmutated input, owned output planes, and the plan-time refusals on the linear, graph
and timed planners. The registry test runs the three descriptor examples on all five
paths.

## Proposed test contracts

All of these are unscoped by platform, because the arithmetic is integer only:

| id | file | name | modes | scope |
|---|---|---|---|---|
| `filter.yaepblur.kernel` | `tests/differential/video-yaepblur.test.ts` | `matches native yaepblur kernels across formats, sizes, radii, sigmas, planes, patterns and native thread counts` | semantic, bit-exact | 8-bit planar gray/yuv420p/yuv422p/yuv444p/yuva420p/gbrp, radius/planes/sigma incl. clipping, r=0 and p=0 copies, threads agreement |
| `filter.yaepblur.cli` | same | `matches native yaepblur CLI rawvideo and framecrc outputs across conversions and timing` | semantic, bit-exact | -vf linear chains with conversions, -ss/-t |
| `filter.yaepblur.graph` | same | `matches native complex yaepblur graphs on the frame-graph path` | semantic, bit-exact | -filter_complex split/transpose/hflip graphs |
| `filter.yaepblur.stream` | same | `matches native replayed yaepblur streams frame by frame` | semantic, bit-exact | createReplayVideoExecution |
| `filter.yaepblur.timed` | same | `matches native yaepblur through the timed backend actor and pull schedulers` | semantic, bit-exact | producer/activation/pull schedulers |
| `filter.yaepblur.reject` | same | `fails like native for unknown and out-of-range yaepblur options and refuses enable= and runtime commands before opening outputs` | semantic | refusals before output |
| `filter.yaepblur.negotiation` | same | `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | semantic, bit-exact | 17 sources |
