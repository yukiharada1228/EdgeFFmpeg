# Default 8-bit video resizing

`resizeVideoFrame` resizes declared gray/gray8, YUV420P, YUV422P, YUV444P,
YUVA420P, NV12, NV21, RGB24, BGR24, RGBA, BGRA, ARGB, ABGR and GBRP frames with the fixed native
default bicubic kernel (B=0, C=0.6). Positive dimensions and arbitrary up/down
ratios are accepted within the signed32 frame layout and caller budgets.
Combined format conversion/resizing is available for the pairs described below.
Alternate kernels and kernel parameters remain incomplete.
A first [linear video filter chain](video-filters.md) exposes fixed-default scale.

```typescript
import {resizeVideoFrame, pixelResizeStateBytes} from '@edge-ffmpeg/swscale';

const state = pixelResizeStateBytes(frame.pixelFormat, frame.width, frame.height, width, height);
const resized = resizeVideoFrame(frame, width, height, {
  maxFrameBytes: 64 * 1024,
  maxStateBytes: state,
  signal
});
```

Input may have a positive padded stride. Output owns a new tight buffer, exact
bigint PTS/time base are copied, and opaque metadata is shallow-copied. Aspect
ratio/color metadata transformations are not implemented. Aggregate input plane storage and each
output frame must fit `maxFrameBytes`; `maxStateBytes` defaults to that limit.
The caller must account for the aggregate input, output and workspace residency.

The state preflight includes horizontal/vertical coefficient and position tables
plus bounded signed32 accumulation rows. Gray/YUV uses one row when vertical
resizing is required; RGB uses three output rows, or four with alpha. Identical
axes are shared across color/alpha planes and interleaved UV components; the
gray/YUV accumulation row is reused sequentially. Odd chroma dimensions round up separately. Coefficient
support grows for downscaling; the bound accounts for it before allocation. Weight
generation avoids support-sized bigint arrays and repeated array shifts. Row
evaluation retains Q7 intermediates, unsigned-add/signed32 wrap behavior, rounding
and clipping without retaining a full intermediate image. Cancellation is checked
at frame/row and bounded inner-loop intervals. VM/GC overhead, actual peak heap,
CPU limits and production performance remain unmeasured.

## Rawvideo CLI

Output `-s WIDTHxHEIGHT` and single-video-stream `-s:v`, `-s:v:0`, `-s:0` select
resizing of the fourteen layouts, including the supported fused format pairs below. The last matching size wins. Input dimensions retain their
separate input scope. Streamcopy preserves input dimensions and ignores output
size values, including invalid strings, as observed in the fixed oracle.
Time selection, frame limits, bitexact framecrc, staged output, short reads and
backpressure use the existing rawvideo path. Output dimensions and buffer/state
reservations are checked before either file opens. Input and encoded output sizes
accept all 55 names in the pinned FFmpeg table, case-sensitively (for example
`qcif`, `hd720`, `uhd4320`). Numeric sizes follow the fixed LP64 parser: ASCII
leading whitespace/signs, one arbitrary ASCII separator and signed32 narrowing
after signed64 decimal saturation. Trailing text/whitespace is rejected. Layout
and resource preflight apply to the resolved dimensions. General video filter
graphs remain unimplemented. The parser is an adapted LGPL component; see
[avutil provenance](../../packages/avutil/NOTICE).

## Evidence and provenance

- 600 strict native raw comparisons: 100 source/destination geometries, three
  deterministic payload seeds, native default and explicit scalar CPU conditions.
- 518 whole native CLI comparisons: multi-frame time/seek selection, raw/framecrc,
  size aliases, last-option precedence and ignored streamcopy sizes, with eleven-byte
  physical reads, empty input, zero frame limits and zero duration.
- Ten native comparisons through the actual staged Node launcher.
- Local workerd/R2 conversion retains the complete native time-clipped 13x7
  framecrc output and verifies staging cleanup with eleven-byte reads.
- Unit coverage includes padded strides, ownership, exact timestamps, state/frame
  budgets, cancellation and pre-I/O rejection. During the coefficient refactor,
  1,036 old/new axes had identical taps, positions and coefficients.

YUV coverage additionally includes 3,600 complete native default/scalar raw
comparisons, 2,784 complete CLI raw/framecrc time-selection comparisons, sixty
actual Node-launcher outputs and six local workerd/R2 time-clipped framecrc
outputs with staging cleanup. Unit cases cover padded planes, shared axes,
constant alpha, UV order and aggregate storage limits. A supplementary pinned
Linux x86_64 run matched all 288 default/scalar one-frame YUV raw comparisons;
it does not establish full Linux resize coverage.

The main resize oracle is the recorded local macOS arm64 build. General
formats/metadata/filter semantics and full swscale conformance
remain unverified. Adapted filter/row arithmetic retains
[LGPL provenance and notices](../../packages/swscale/NOTICE).

Size-syntax evidence adds 62 complete native empty-input framecrc comparisons
(all 55 names plus seven numeric variants), five complete nonempty output-size
framecrc comparisons and fourteen malformed input/output rejection cases. Actual
Node raw/framecrc outputs cover named input and alternate output separators; the
gray workerd/R2 fixture uses colon-separated input/output sizes. Empty-input
named-size coverage does not establish large-frame processing or performance.

## RGB numeric stages

RGB resizing follows the native Q6 RGB-to-YUV input stage, Q14 horizontal
filtering into Q7 rows, Q12 vertical filtering and full-chroma RGB output. Even
source widths can use paired RGB chroma when reducing width by at least half.
Packed output distinguishes optimized vertical taps from general filter rounding;
GBRP retains general rounding. Signed32 matrix wrap and clipping remain explicit.
Packed alpha expands to Q6 with its high bits repeated before filtering; this
can increase intermediate alpha values compared with input bytes. Identity-size
requests copy tight component bytes without a color round trip. Source padding,
aggregate storage, ownership, exact timestamps and cancellation use the common
resize validation. No complete intermediate image is retained.

Evidence adds 4,200 complete native default/scalar API raw comparisons, 3,248
whole multi-frame CLI raw/framecrc outputs, 96 alpha-endpoint comparisons, seventy
actual Node outputs and seven local workerd/R2 framecrc anchors. Linear filter
coverage expands to 840 native outputs across all fourteen layouts. A fresh
pinned Linux x86_64 run of the public API matched 336 default/scalar raw outputs;
this supplements the local macOS oracle without establishing full Linux or
production conformance. Alternative color matrices, metadata transformation and general swscale behavior
remain incomplete. Fused format conversion is described below.

## Fused resizing and format conversion

`resizeVideoFrame` accepts `outputPixelFormat`; `pixelResizeStateBytes` accepts
the target format as its sixth argument. `canResizePixelFormat(source, target)`
reports geometry-changing support. All 196 directed pairs among the fourteen formats have geometry-changing
paths, including YUV-to-RGB. The selected arithmetic profile and geometry
remain part of the compatibility scope. Equal geometry delegates format changes to the existing
converter, retaining its unscaled fast paths and arithmetic-profile restrictions.
The optional seventh state argument and `arithmetic` option select that profile.

```typescript
const state = pixelResizeStateBytes('rgba', 5, 3, 13, 7, 'nv12');
const output = resizeVideoFrame(frame, 13, 7, {
  outputPixelFormat: 'nv12', maxFrameBytes: 65536, maxStateBytes: state
});
```

Fused evaluation maps source and destination components directly; it does not
quantize an intermediate resized frame before format conversion. RGB-to-RGB
uses the output layout's Q9 rounding and alpha requirements. RGB-to-YUV uses Q6
input samples and paired chroma when selected by the destination geometry.
Full/limited gray range conversion occurs after horizontal Q7 filtering and
before the vertical stage. Gray-to-RGB retains Q9 precision through its final
rounding; simply replicating a byte-quantized gray resize is not equivalent.
Missing chroma and alpha are filled with neutral 128 and opaque 255 as applicable.

Common ownership, positive strides, aggregate input storage, exact bigint PTS,
coefficient/state preflight and cancellation apply. Non-RGB output and gray-to-RGB
reuse one accumulation row; RGB-to-RGB uses three or four. Linear video filter chains now negotiate explicit output and declared-format
candidate lists, retaining chroma/alpha conversion boundaries; graph application enforces its negotiated format and arithmetic.

Evidence adds 18,816 whole native default/scalar API raw comparisons across all
196 pairs, twenty-four geometry combinations and two independent payload seeds;
4,704 full native CLI raw/framecrc outputs with four time profiles and eleven-byte
reads; thirty-two actual Node outputs; and eight local workerd/R2 time-clipped
framecrc anchors with staging cleanup. Padded inputs, exact budgets, ownership,
identity-size conversion delegation and explicit scalar inverse handling have
unit coverage. These scopes do not certify general color metadata,
all Linux configurations or production Workers behavior.

A supplementary fresh Linux x86_64 public-API run matched all 616 default/scalar
raw outputs across the 154 pairs at two odd/even geometry combinations. Reference
binary/compiler/flags, input hashes, portable bundle hash and observations are
archived separately. This does not replace full canonical Linux CI or production
Workers verification.

## Resized YUV-to-RGB profiles

The inverse resize path retains filtered luma, chroma and optional alpha in
bounded signed32 output rows. Odd output widths, GBRP and full-chroma sources
use the full Q9 matrix path; other packed outputs use native table arithmetic.
One-tap, two-tap and general vertical dispatch retain their distinct rounding.
The explicit x86_64 profile emulates the fixed Linux build's inline MMXEXT
multiply-high, signed16 subtraction, logical averaging, per-product truncation
and alpha behavior, followed by the native final-two-row C fallback. The
aarch64 and scalar scaled profiles follow the recorded C arithmetic. No host
SIMD instructions or native fallback are used. All axes and output rows are
included in state preflight.

Unchanged-size conversions continue to use the prior converter. In particular,
its aligned even-height default AArch64 NV12/NV21 restriction and explicit scalar
override remain in force. A separate scaled-alignment diagnostic observed one
output hash for each of sixteen scaled requests over 768 default and 192 scalar
executions, with matching profiles. This observation does not prove absence of
races or establish unscaled compatibility.

The public API replays 1,008 locked Linux default and 1,008 independent scalar
whole raw hashes with recorded binary/compiler/flags/input identities. These
regression fixtures originate from a separately archived native run; replay is
not a fresh Linux execution gate. Another 252 whole native raw/framecrc outputs
pass through the actual staged Node launcher with reference-selected arithmetic.
Twelve Node outputs independently check the explicit Linux profile and global
scalar override against locked raw hashes that distinguish the profiles. Fresh
ARM and Linux default framecrc fixtures cover all 42 inverse pairs through two
local workerd/R2 profiles (84 outputs), short reads and staging cleanup. Full
Linux CI, arbitrary matrices/metadata and production runtime conformance remain
unverified. General video-filter format negotiation remains incomplete; linear output and single-format constraints are documented in video-filters.md.

A further 3,864 fresh native default/scalar public-API comparisons cover all
42 inverse pairs at 1x1/2x2/3x3 and aligned 16x6 inputs, two payload seeds and
six target shapes (unchanged dimensions use the existing conversion contract).
These checks preserve separate default and scalar arithmetic profiles.

A fresh Linux x86_64 public-API probe also matched 336 default/scalar raw outputs
for all 42 inverse pairs at tiny, odd and aligned horizontal-only/vertical-only
resize geometries. Each native CPU condition is compared to its explicit portable
arithmetic profile; binary and source bundle hashes are recorded separately.
