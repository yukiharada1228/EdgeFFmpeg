# Default rawvideo color conversion

The portable swscale converter now connects full-range RGB, limited-range YUV444 and full-range gray with the pinned native default BT.601 behavior. It also converts gray to/from each declared YUV layout without chroma interpolation: the gray source supplies neutral U/V, while YUV-to-gray reads luma and expands its range.

Supported color paths, in addition to component packing:

- RGB24/BGR24/RGBA/BGRA/ARGB/ABGR/GBRP to and from YUV444P.
- Those seven RGB layouts to and from gray/gray8.
- Gray/gray8 to and from YUV420P, YUV422P, YUV444P, YUVA420P, NV12 and NV21.

These forty input/output pairs form the color foundation. RGB-to-subsampled-YUV and YUV chroma conversion are documented in the chroma extension below; subsampled YUV-to-RGB is documented in [the inverse scope](pixel-inverse.md) with explicit profile restrictions. Different color matrices, explicit range overrides, transfer functions, primaries, HDR and scaling remain incomplete. The API assumes the documented default rawvideo color interpretation; arbitrary frame metadata is shallow-copied and does not select a color transform. Unsupported CLI color options are rejected.

## Numeric behavior

The forward matrix uses the native legacy BT.601 Q15 coefficients: luma (8414, 16519, 3208), Cb (-4865, -9528, 14392), Cr (14392, -12061, -2332). Luma has a 16 offset, chroma a 128 offset. Native intermediate Q6 quantization and final Q7 rounding combine to an integer numerator bias of 16640 before division by 32768. Using a real-valued matrix followed by one final rounding differs at boundary colors.

RGB-to-gray retains the limited-luma Q6 intermediate and then performs the native full-range expansion, rather than applying a separately rounded full-range RGB matrix. Limited/full luma conversion uses Q7 pixels with Q14 affine coefficients 19078 / -39084288 for expansion and 14071 / 33561472 for contraction. Both the affine operation and final sample conversion retain their integer rounding stages.

The reverse YUV444 matrix uses Q13 coefficients 9539 (luma), 13075 (Cr to R), -3209 / -6660 (Cb / Cr to G) and 16525 (Cb to B). The default generic native path uses a signed 32-bit Q22 accumulator before clipping. That wrap is observable for some out-of-range super-white saturated blue inputs: (Y,Cb,Cr) = (254,255,160) produces RGB (255,201,0). The pinned behavior is modeled explicitly, including these input values, rather than replacing it with a floating-point matrix and ideal saturation. This is a reference-profile compatibility behavior, not a normative claim about color science or other native builds.

All arithmetic fits exact JS integer precision before the deliberate 32-bit wrapping step. No pixel is converted through floating-point approximation, per-pixel arrays, native code, Wasm or a remote service. Source geometry, input plane/stride checks, aggregate input storage, destination budget, cancellation, owned output and timestamp handling use the existing conversion boundary. Output alpha is opaque when the source has none; conversion to gray or YUV444 drops source alpha without premultiplication.

## Provenance and evidence

The TypeScript equations were authored as a behavior model. Matrix coefficients and quantization stages are traced to the fixed upstream commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8, particularly libswscale/input.c, utils.c, swscale.c, output.c and yuv2rgb.c. No upstream C source text is copied into the implementation. The repository-wide provenance and licensing audit remains open; this document does not assign a public license.

Native differential evidence compares complete output bytes and framecrc in 1680 scenarios: forty pairs, seven odd/even geometries, three scoped time/frame profiles and two output formats. Edge reads are physically capped at eleven bytes. Another 120 cases compare 257x31 frames under deterministic random seeds and full byte ramps; they exercise rounding, range clipping and non-nominal YUV values across all pairs. Native options and default CPU dispatch are preserved.

Unit anchors cover RGB primaries, intermediate rounding, padded GBR planes, large/unknown PTS, neutral chroma, gray endpoints and signed overflow before clipping. The actual Node CLI launcher compares ten native outputs. Local workerd compares five scoped color paths with three-byte reads and fixed native framecrc anchors. Local R2 checks RGB24-to-YUV444 output and staging cleanup under a unique fixture namespace.

The local reference is macOS arm64; canonical Linux x86_64, other dispatch paths, full swscale conformance, observed CPU/heap behavior and production Cloudflare verification remain unverified. Full FFmpeg compatibility is not certified.

## Chroma extension

Default chroma resampling now extends these paths to all six declared YUV layouts and RGB-to-subsampled-YUV. See [the chroma scope](chroma-resampling.md) for numeric precision, even/odd fast paths, resource accounting, inherited component licensing and evidence. Subsampled YUV-to-RGB is now documented in [the inverse scope](pixel-inverse.md).


## Limited-range matrix metadata

The numeric YUV-to-RGB paths now read optional frame `metadata.colorSpace`.
Supported numeric matrices0,1,2,4,5,6,7,9 use the pinned libswscale coefficient
and fixed-point table setup. Unspecified metadata preserves the previous BT601
profile. Unsupported matrices and full-range RGB conversion fail explicitly.
Only default AArch64 and scalar profiles have the new host differential matrix;
x86 profile matrix conformance still requires its own native host evidence.

Color-family changes copy metadata and update its matrix/range values. Borrowed
metadata is not changed. Full-range YUV-to-gray bypasses the limited-to-full
range transform; this is independent of unfinished full-range RGB support.
See tests/differential/pixel-color-matrix.test.ts and tests/workers/h264-color.test.ts
for the exact comparisons; this does not certify general color conformance.
