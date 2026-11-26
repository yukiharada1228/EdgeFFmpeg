# convolution video filter

`convolution` follows the eight-bit `convolution` filter of the pinned
`libavfilter/vf_convolution.c` (FFmpeg 9.0.2, commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/convolution.ts`. The parser and the kernels are
in `packages/avfilter/src/video-convolution.ts`. Provenance is in
`packages/avfilter/NOTICE-CONVOLUTION`. The other filters in that file (prewitt,
sobel, roberts, kirsch and scharr) are not part of this item.

## Syntax

`convolution[=0m:1m:2m:3m:0rdiv:1rdiv:2rdiv:3rdiv:0bias:1bias:2bias:3bias:0mode:1mode:2mode:3mode]`.
The shorthand follows the native declaration order. The same names also work as
keys. Each plane `N` (0-3) has its own option set:

| Option | Type and range | Default | Meaning |
|---|---|---|---|
| `Nm` | string | `0 0 0 0 1 0 0 0 0` | Integer elements separated by spaces or `\|` (native `av_strtok(" \|")`). |
| `Nrdiv` | float, 0..INT_MAX | 0 | Multiplier. 0 means `1/sum` of the elements, and the sum counts as 1 when it is 0. The sum is a float sum, so a negative sum gives a negative rdiv. |
| `Nbias` | float, 0..INT_MAX | 0 | Added after the multiply. |
| `Nmode` | `square`/`row`/`column` or 0..2 | `square` | `square` takes 9, 25 or 49 elements (3x3, 5x5, 7x7). `row` and `column` take any odd count from 1 to 49 taps. |

Gray uses plane 0. yuv uses planes 0-2, yuva420p uses planes 0-3, and gbrp
uses its memory planes in the order G, B, R. As natively, all four matrices are
validated whatever the format, so a bad `3m` is refused on gray too.
Convolution has no `planes` option. To leave a plane unfiltered, keep its
identity matrix: native copies that plane when rdiv is 1 and bias is 0.

Accepted forms and the refusals of forms native also refuses. Every refusal
happens before any output is opened:

- An even element count, including an empty matrix: `number of matrix elements must be odd`.
  Natively this is EINVAL, exit status 234 on Linux.
- A square matrix whose count is not 9, 25 or 49. Natively this is EINVAL with no message.
- `Nrdiv` or `Nbias` outside [0, INT_MAX], and `Nmode` outside 0..2.
  Natively this is the AVOption range check, ERANGE, exit status 222 on Linux.
- Unknown options, including `planes`, `scale` and `threads`.
  Natively this is `Option not found`, exit status 8.

These forms native accepts are refused here explicitly:

- A matrix token that is not a plain decimal int32, such as `1.5`, `x`, `0x1`,
  a tab, or a value outside the int range. Native `sscanf("%d")` keeps a leading
  integer, leaves a stale (zero) element for a non-numeric token, and
  overflows.
- More than 49 elements. Native silently ignores tokens past 49.
- Expressions and non-decimal literals in `Nrdiv` and `Nbias`, such as `1/16`
  and `nan`. Only constant decimal literals are accepted. The parsed double
  is range-checked, then stored as a float, as natively.
- `enable=` timeline expressions. Native has a generic timeline.
- Runtime commands. Native accepts every option as a command and reruns
  `param_init`. Here option commands answer ENOSYS (-38), and `enable` answers
  AVERROR_PATCHWELCOME from the disabled timeline.
- **The native null-filter crash.** `param_init` gives no eight-bit filter to an
  identity square matrix (it plans a copy). It then clears the copy flag when
  rdiv is not 1 or bias is not 0, so `filter_slice` calls a null function
  pointer. The differential test observes SIGSEGV for this on every processed
  plane, for example `convolution=0bias=5` or `convolution=1m=0 0 0 0 1 0 0 0 0:1rdiv=0.5`
  on yuv420p. Only the planes the negotiated format has count, so
  `convolution=3rdiv=2` runs on yuv420p, where native ignores plane 3, and is
  refused on yuva420p. The refusal (`Convolution identity matrix Nm with rdiv or
  bias is not implemented (native calls a null filter)`) comes from `geometry`
  on every path and again in `frame`.

## Semantics

For each output sample, the filter sums `(unsigned)src * matrix[i]` over the
taps, modulo 2^32, and reads the result as an int. Square mode covers an n x n
window. Row mode covers the 2r+1 samples of the same row, and column mode the
samples of the same column. Every tap coordinate goes through
`avpriv_mirror(x, size-1)`: it reflects without repeating the edge sample, and
repeats the reflection when the kernel is wider than the plane. A 49-tap row
on a 3-pixel plane therefore works, and a one-pixel plane reads itself. No plane
size is refused.

The sample is then `av_clip_uint8((int)sum * rdiv + bias + 0.5f)`. Each step is
emulated with `Math.fround` and kept unfused: the int to float conversion, the
multiply, `+bias` and `+0.5f`. The conversion to int truncates. A value outside
the int range becomes INT_MIN, as x86-64 `cvttss2si` does, and clips to 0. So
`0bias=2147483647` turns a processed plane black, and a sum of 2147483647
(which rounds to 2^31) gives 0. Identity planes with rdiv 1 and bias 0 are
copied byte for byte.

Output planes are owned and tight, with positive strides. PTS (bigint) and
metadata are copied. Input planes are never mutated. Frame bytes and resident
input storage are bounded by `maxFrameBytes`. `AbortSignal` is checked per row
and every 4096 samples.

### Native column mode writes past the row

`filter_column` handles 16 columns per call. Each slice processes 16-column
groups from its own `slice_start`, reading and writing whole groups past the
end of the row. The visible samples are always computed from their own
column. But if a group runs past the frame linesize, its writes land in the
next row. Two cases cause this:

- slice threading, where a slice can start at any column;
- `-cpuflags 0`, where the buffer pool alignment drops to 8 bytes and even one
  thread overruns.

Native output then depends on write order. Probes on the sandbox build found
these cases:

- gray 64x9 and 128x9 differ between default threads and `-filter_threads 1`;
- 8x6 and 32x9 differ under `-cpuflags 0` with default threads;
- 17x9 and 33x9 differ under `-cpuflags 0` even with one thread.

EdgeFFmpeg computes the defined result: the mirrored column sum for every
visible sample. That equals native whenever no group passes the linesize, in
particular single-threaded native with the default alignment of 16 bytes or
more. Groups start at multiples of 16 there, inside the aligned row.

The differential tests therefore compare column-mode filters with
`-filter_threads 1 -filter_complex_threads 1` native. For square and row
filters they also require native's default threads and single thread to agree
([THREADS]). The per-source negotiation helper runs native with `-cpuflags 0`,
so its filter avoids column mode. This is native undefined behaviour (out of
bounds writes), not a read EdgeFFmpeg mirrors.

## Formats and paths

`formats()` is the native `vf_convolution.c` list in declared order. It has 57
formats: planar YUV, YUVA, GBR(A)P and gray at every depth, yuvj included.
The shared negotiators therefore pick exactly what native picks. Frames run in
the eight-bit layouts with frame storage: gray, yuv420p, yuv422p, yuv444p,
yuva420p and gbrp. They also run in the legacy yuvj420p, yuvj422p and yuvj444p
sources of linear chains. nv12 and nv21 convert to yuv420p, and rgb24 and
bgr24 to gbrp. Packed RGB with alpha converts to `gbrap` natively, which has
no frame storage here. Those picks are refused by name (`Video filter
convolution input negotiates gbrap, which is not implemented`) on every path,
before any output.

Paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is a
stateless `frame` role with no `actorFrame`, so actor and timed execution call
the same `frame` function.

## Determinism and arithmetic profile

- The integer sums are exact and platform-independent.
- With rdiv 1 and bias 0 the float steps are exact. This covers matrices that
  sum to 0 or 1 with no rdiv, or an explicit `Nrdiv=1`. Their sums stay well
  inside ±2^24 in these tests. They run on every platform.
- Any other rdiv or bias is float-sensitive. clang on macOS arm64 contracts
  `sum*rdiv+bias` into one fused multiply-add. gcc on x86-64 without FMA keeps
  each step in float, which is the emulated profile. The conversion of
  out-of-range values to INT_MIN is x86-64 behaviour too, where arm64 saturates.
- These cases run only on linux-x64: the float differential tests have constant
  titles and are skipped elsewhere with `it.skipIf`. No case is dropped inside a
  passing test.
- No macOS difference has been measured on a native build, so the gate is a
  precaution. Emulating a fused multiply-add, or a double intermediate, in the
  kernel makes the float matrix test fail on this Linux build.

## Evidence

All comparisons run the sandbox `.build/reference/ffmpeg` (Linux x86_64, built
with `--disable-x86asm` at commit 946fcce0, sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, compiler
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`) at test time. Each test checks
the commit and the `--disable-x86asm` flag in `build-metadata.json`. None of
these tests has run on macOS arm64 or in the pinned linux-x64 image yet.

Inputs are rawvideo in the operator's own formats (gray, yuv420p, yuv422p,
yuv444p, yuva420p, gbrp), so no implicit conversion runs. Each input has three
frames: LCG noise; a ramp with edges and single dark and bright pixels; and a
constant 200 plane. Sizes are 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 and 40x7.

`tests/differential/video-convolution.test.ts`:

- `matches native integer convolution for every format, mode, matrix size, plane selection and size with default and single filter threads`
  (all platforms): 1,428 raw byte comparisons, from 17 integer filters x 6
  formats x 7 sizes on both `compileVideoFilterChain` and
  `compileVideoFilterGraph`. The filters cover:
  - the default, 3x3, 5x5 and 7x7 identity copies;
  - sharpen, Laplacian, edge and emboss 3x3 kernels;
  - asymmetric 5x5 and 7x7 kernels summing to 0 or 1;
  - row and column kernels of 1, 3, 5, 7, 9, 15, 25, 31 and 49 taps;
  - explicit `rdiv=1` box and Gaussian kernels that saturate;
  - per-plane identity and filter mixes;
  - `|` separators and extra spaces;
  - the full positional form.

  Native runs as split batches with default threads and with one filter thread.
  For the 12 filters without column mode, both runs must agree (504 [THREADS]
  checks).
- `matches native float convolution rdiv, bias and conversion edges on linux-x64`
  (linux-x64 only): 840 raw comparisons, from 10 float filters x 6 formats x 7
  sizes on both planners, plus 252 thread-agreement checks (the 6 filters without column mode). The filters cover:
  - auto 1/9, 1/16, 1/25, 1/49 and 1/15 rdiv;
  - explicit rdiv from 1e-7 to INT_MAX;
  - bias from 0.1 to INT_MAX;
  - negative-sum auto rdiv;
  - elements up to INT_MAX with wrapped sums;
  - values converting outside the int range;
  - rdiv/bias pairs whose products land just below a half, where unfused,
    double and fused arithmetic all differ.
- `matches native integer convolution rawvideo and framecrc through the -vf, -filter_complex and timed backend CLIs with and without -ss/-t`
  (all platforms): 1,728 whole-output comparisons. The matrix is 6 formats x
  {7x5, 17x9} x 4 chains (including hflip, chained convolutions and
  transpose) x {rawvideo, framecrc} x 3 timing scopes (none, `-ss 0.04` input
  with `-t 0.05`, `-ss 0.04 -frames:v 1`) x 6 executions. The executions are
  `-vf` (linear), `-filter_complex` (graph), two-input `-filter_complex`
  (stream), and the timed backend with the `activation` and `producer`
  schedulers (actor) and the `pull` scheduler (timed).
- `matches native float convolution through the -vf, -filter_complex and timed backend CLIs on linux-x64`
  (linux-x64 only): 288 whole-output comparisons, from 6 formats x 7x5 x 2
  float chains x 2 muxers x 2 scopes x 6 executions.
- `matches native replayed integer convolution branches frame by frame`: 24
  `createReplayVideoExecution` graphs, with split, hstack, transpose, nullsink
  and hflip branches, checking raw bytes and PTS.
- `refuses invalid and unimplemented convolution options on every path before opening outputs, with native statuses for native refusals`:
  10 forms native refuses, with native exit status 234 (EINVAL), 222
  (ERANGE) or 8 (option not found), read from `os.constants.errno` for the
  host. The odd-count message is also checked. 6 forms native accepts (exit 0,
  full output) are refused here. Each is refused on the 5 paths through the
  CLI, with exit 1 and no output opened, and by both planners: 80 refusals.
- `refuses processed identity planes whose rdiv or bias clears the copy, where native calls a null filter, before opening outputs on every path`:
  4 filters x 6 formats. 17 cases crash natively with SIGSEGV and are refused
  here on the 5 paths and both planners (85 refusals). The other 7, where the
  plane does not exist in the format, match native bytes.
- `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path`:
  `tests/helpers/video-negotiation-cases.ts` runs an integer square/row/square
  filter from 17 sources. 13 run byte-exact on the five paths (`-cpuflags 0`,
  scalar), with yuvj on linear chains only. argb, rgba, abgr and bgra are
  refused naming `gbrap` on the five paths and through the media
  `-vf`/`-filter_complex` and timed producer/pull CLIs, with no output opened.
  89 checks in all.

These mutations each fail at least one test:

- unfused float replaced by a double intermediate, or by a fused multiply-add
  (float matrix);
- the INT_MIN conversion replaced by plain truncation (float matrix);
- the wrapping `Math.imul` sum replaced by exact arithmetic (float matrix);
- the mirror replaced by a single reflection (integer matrix).

`tests/unit/video-convolution.test.ts` (4 tests) covers:

- option parsing, shorthand order, modes, separators, rdiv resolution and
  float storage;
- every parse refusal;
- the descriptor facts and the native format list;
- hand-computed and independently referenced kernels for every mode, including
  kernels wider than the plane and one-pixel planes;
- wrapped sums and the conversion edge cases;
- per-plane yuva420p and gbrp results;
- the null-filter refusal per format;
- budgets, malformed strides and storage, plane counts and time bases;
- invalid steps, and cancellation before and during a frame;
- that the input is not mutated, and that output planes are owned;
- linear and graph budgeting, negotiation from nv12 and rgb24, and the gbrap
  refusal;
- refusal of the timeline and of runtime commands.

The unchanged `tests/unit/video-operator-registry.test.ts` runs the six
descriptor examples on all five paths.

## Proposed test contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| `video.convolution-integer-matrix` | tests/differential/video-convolution.test.ts | matches native integer convolution for every format, mode, matrix size, plane selection and size with default and single filter threads | 1,428 linear/graph raw comparisons and 504 thread-agreement checks | all |
| `video.convolution-float-matrix` | tests/differential/video-convolution.test.ts | matches native float convolution rdiv, bias and conversion edges on linux-x64 | 840 linear/graph raw comparisons and 252 thread-agreement checks of float rdiv/bias | linux-x64 |
| `video.convolution-cli` | tests/differential/video-convolution.test.ts | matches native integer convolution rawvideo and framecrc through the -vf, -filter_complex and timed backend CLIs with and without -ss/-t | 1,728 rawvideo/framecrc CLI outputs on linear, graph, stream, actor and timed | all |
| `video.convolution-float-cli` | tests/differential/video-convolution.test.ts | matches native float convolution through the -vf, -filter_complex and timed backend CLIs on linux-x64 | 288 float CLI outputs on the five paths | linux-x64 |
| `video.convolution-stream` | tests/differential/video-convolution.test.ts | matches native replayed integer convolution branches frame by frame | 24 replay graphs, raw bytes and PTS | all |
| `video.convolution-refusals` | tests/differential/video-convolution.test.ts | refuses invalid and unimplemented convolution options on every path before opening outputs, with native statuses for native refusals | 16 forms, native statuses, 80 path refusals | all |
| `video.convolution-null-filter` | tests/differential/video-convolution.test.ts | refuses processed identity planes whose rdiv or bias clears the copy, where native calls a null filter, before opening outputs on every path | 17 native SIGSEGV cases refused on five paths, 7 byte matches | all |
| `video.convolution-negotiation` | tests/differential/video-convolution.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | Native picks from 17 sources; gbrap refused by name | all |
| `video.convolution-options-api` | tests/unit/video-convolution.test.ts | parses native defaults, shorthand order, modes, separators and float rdiv and bias into frozen param_init planes | Parser, refusals and descriptor facts | all |
| `video.convolution-frame-api` | tests/unit/video-convolution.test.ts | convolves square, row and column taps with mirrored edges, wrapped sums and unfused float rounding into owned tight planes | Kernel semantics | all |
| `video.convolution-limits` | tests/unit/video-convolution.test.ts | refuses native null-filter planes, unsupported layouts, budgets, malformed storage, settings and cancellation explicitly | Limits and refusals | all |
| `video.convolution-plans` | tests/unit/video-convolution.test.ts | budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands | Plans, negotiation, command refusal | all |

## Unsupported

- `enable=` and every runtime command.
- Non-decimal or non-int32 matrix tokens, more than 49 tokens, and expression
  or non-decimal rdiv and bias values.
- Processed identity square planes whose rdiv is not 1 or whose bias is not 0,
  where native crashes.
- Formats deeper than eight bits (`filter16_*`), and every native format
  without frame storage here: yuva444p, yuva422p, yuv440p, yuvj440p, yuvj411p,
  yuv411p, yuv410p, gbrap and gray9-16. A negotiation that picks one, such as
  packed RGB with alpha picking `gbrap`, is refused by name.
- Native column-mode output where its 16-column groups overrun the linesize
  (slice threading, `-cpuflags 0`). EdgeFFmpeg gives the defined result instead.
- EdgeFFmpeg's CLI exits with 1 for filter refusals, not native's errno
  status. The front end maps every filter error to 1.
- H.264/MP4 framecrc input has no convolution comparison.
