# Default chroma resampling and RGB subsampling

The rawvideo converter now supports all pairs among YUV420P, YUVA420P, NV12, NV21, YUV422P and YUV444P, plus RGB24/BGR24/RGBA/BGRA/ARGB/ABGR/GBRP to those six YUV layouts. Gray and component-packing paths retain their existing behavior. Geometry and default BT.601 interpretation remain unchanged. Subsampled YUV-to-RGB is now documented in [the inverse scope](pixel-inverse.md), including profile/geometry restrictions. Arbitrary scaling, color matrices/range overrides and explicit chroma locations remain incomplete.

## Coefficients, precision and borders

The default bicubic kernel uses B=0 and C=0.6. Coefficient initialization models the fixed native integer pipeline using bigint: Q16 coordinate increments, Q30 distances, the truncated Q24 C parameter, small-tail reduction, border folding and error-feedback coefficient normalization. Horizontal coefficients use Q14 and vertical coefficients Q12. Horizontal filtering produces signed Q7 samples before vertical rounding and byte clipping. Tiny axes follow native support limits, including its single-tap cases. Near-zero coefficient reduction matters for one-byte differences on larger odd axes.

Packed and planar 8-bit RGB both aggregate horizontal pixel pairs on even widths before chroma filtering. Odd widths retain full input chroma and use the horizontal filter. RGB chroma samples retain Q6 intermediate values through the filter; converting them to bytes first produces different results. BGR24 on even widths has a separate native YUV420P/YUVA420P path: luma is truncated and chroma uses a truncated 2x2 component average, duplicating the last row for odd heights. NV12/NV21 destinations use the generic path. RGB alpha passing through the generic YUVA conversion has the native Q6 expansion/rounding: alpha 128..254 increases by one, while 255 remains saturated. Component-only alpha packing stays unchanged.

## Resource boundary

`PixelConversionOptions.maxStateBytes` bounds filter indices, coefficients and the vertical row workspace independently of `maxFrameBytes`. Its default is maxFrameBytes. `pixelConversionStateBytes(input, output, width, height)` returns a conservative typed-buffer bound before allocation. Axes are limited to the up-to-twofold chroma sampling ratios required by the supported unchanged-geometry formats. It is not a general image-scaling planner.

Each axis uses signed typed coefficient/index arrays. Initialization holds a bounded temporary bigint row, and filtering reuses at most twelve horizontal rows instead of a full intermediate image. Cancellation is checked during coefficient generation, rows and pixel blocks. Input/output ownership, positive padded strides, bigint PTS and staged writes retain their existing contract. CLI preflight adds filter/workspace storage to the simultaneous frame payload reservation before opening input or output. JS object/BigInt overhead, GC behavior and observed CPU/heap remain unverified beyond conservative payload accounting.

## Provenance

`packages/swscale/src/chroma-filter.ts` is an adapted implementation from the pinned FFmpeg commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8, particularly libswscale/utils.c (initFilter), swscale.c and output.c. Its SPDX identifier is LGPL-2.1-or-later. Upstream author/copyright notices, adaptation details and the full inherited license are retained in [NOTICE](../../packages/swscale/NOTICE) and [the license text](../../packages/swscale/LICENSES/LGPL-2.1-or-later.txt). This component notice does not assign a project-wide public license; the remaining dependency/provenance audit is still open.

## Evidence

Native differential tests compare complete raw bytes and framecrc in 1152 YUV-pair scenarios: six input and output layouts, eight geometries from 1x1 and 2x2 through odd 127x65, two time profiles and two output formats. Another 1120 comparisons cover seven RGB inputs and five subsampled YUV outputs under the same geometry/time/output matrix. The large odd cases protect coefficient reduction and border behavior. Native default CPU dispatch and media options are preserved.

Unit anchors check odd chroma borders, padded plane strides, owned output, large PTS, even/odd RGB sampling, native alpha rounding, cancellation and filter-storage preflight before I/O. The actual Node CLI launcher compares ten outputs. Local workerd compares five scoped paths, including up/down chroma filtering, BGR even-width/odd-height behavior and YUVA alpha, using three-byte reads and native framecrc anchors. Local R2 verifies staged RGB-to-NV12 output and cleanup under an isolated fixture namespace. Other native platforms, production Cloudflare and full swscale conformance remain unverified.
