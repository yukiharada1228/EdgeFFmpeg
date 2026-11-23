# Subsampled YUV to RGB

The rawvideo converter connects YUV420P, YUVA420P, YUV422P, NV12 and NV21 to RGB24, BGR24, RGBA, BGRA, ARGB, ABGR and GBRP. These thirty-five format pairs complete the format-level conversion graph among the fourteen declared 8-bit layouts. Geometry, numeric profile and resource constraints still apply; this is partial implementation evidence, not full swscale conformance.

## Numeric profiles

`PixelConversionOptions.arithmetic` and `createMediaBackend({pixelArithmetic})` accept `aarch64`, `scalar` or `x86_64`. The initial default, aarch64, emulates the recorded macOS arm64 oracle. No profile inspects the execution host or executes host SIMD instructions. The scalar profile corresponds to explicit native `-cpuflags 0`; the CLI option selects it. The x86_64 profile models the fixed Linux oracle with external x86 assembly disabled and inline MMXEXT enabled. The Node launcher accepts `EDGEFFMPEG_PIXEL_ARITHMETIC=x86_64`; this chooses portable arithmetic without changing native comparison options. Other x86 builds/CPU capability sets and full canonical conformance remain unverified.

The converter preserves distinct native paths:

- Planar YUV on even heights selects the native unscaled path. The AArch64 profile uses per-product signed high-multiply truncation and rounded narrowing on 16-pixel aligned widths. Other widths use the native scalar color-table arithmetic.
- Generic packed output on even widths reuses chroma for pixel pairs and applies the scalar tables after vertical interpolation. Odd widths and generic GBRP output retain full horizontal chroma precision through the matrix.
- Generic filtering keeps Q7 horizontal samples and Q9 matrix inputs. GBRP's generic output always rounds at its vertical conversion; optimized packed two-tap paths may truncate. Rounding chroma to byte samples before the matrix is incompatible.
- The right-border coefficient window is retained even when a leading coefficient is zero. Equivalent numeric weights in a shifted window can select a different native optimized path and change alpha rounding.
- Linux MMXEXT generic BGR24/BGRA output uses Q3 signed multiply-high arithmetic. The optimized one/two-tap path chooses the first chroma row or a half-row average at the native 2048 threshold; the general path truncates each coefficient product and adds a rounder. RGBA uses MMXEXT only on the general-filter path. The last two output rows return to C arithmetic. Alpha copies and scalar generic alpha quantization remain separate.

Fresh Linux comparisons cover 560 default and 560 explicit scalar cases: thirty-five format pairs, sixteen tiny/odd/even geometries through 127x65, one deterministic input frame, and raw output. All matched their respective portable profiles. [Expanded locked native fixtures](../../compat/behavior-specs/inverse-linux-x64-expanded.json) preserve both expected hashes and reference provenance. Six locked-default cases also pass through the actual Node launcher and bounded short-read workerd CLI execution.

A subsequent fresh Linux experiment passed 4,480 complete-output comparisons:
two input frames, 25 fps, full versus output-time-clipped selection, raw/framecrc,
and independent default/scalar native conditions. The
[locked time/framecrc fixtures](../../compat/behavior-specs/inverse-linux-time.json)
are replayed through the portable frontend with eleven-byte reads in integration
tests. This is scoped Linux evidence, not all time/seek semantics, input payloads,
rates or the entire reference CI gate. See [Linux reference evidence](linux-reference.md).

The default native differential matrix and native-dependent launcher test select
their explicit portable profile from the validated reference build record, not
the execution host. The helper checks the current ffmpeg artifact SHA, upstream
commit and configure flags before selecting a known target. Native default CPU
options remain unchanged. The ARM-specific rejection check explicitly selects
the ARM profile even when the current oracle is Linux.

Generic and unscaled alpha paths remain separate. Native unscaled conversion copies alpha, while some optimized generic paired-pixel paths use a 255/256 alpha conversion. Opaque alpha is generated when the source has none. The scalar unscaled implementation does not write an odd final pixel on even-height planar input. The owned TypeScript destination starts zeroed, matching the recorded fresh-process fixtures; other native allocation/reuse states for that unwritten tail are not certified.

## Nondeterministic reference condition

The fixed local reference has an unstable aligned semiplanar AArch64-default path. Repeated identical 16x6 NV12/NV21-to-RGB24 commands produced multiple output SHA-256 values, while the single-filter-thread controls were stable. The input, binary hash, upstream commit, generation rule and observed hash frequencies are retained in [the behavior fixture](../../compat/behavior-specs/inverse-native-instability.json). The control's `-filter_threads 1` is diagnostic evidence; it is not substituted for the default comparison condition.

The default AArch64 numeric profile conservatively rejects aligned (width divisible by 16), even-height NV12/NV21-to-RGB before opening input or output. It raises UnstablePixelReferenceError in the library and an explicit unsupported-command diagnostic in the CLI. This is a known incompatibility. Explicit scalar arithmetic remains supported and independently compared. Other dimensions continue to use their deterministic default paths. Format-level `canConvertPixelFormat` does not certify every geometry/profile combination.

Differential tests preserve strict complete-byte equality on the supported default paths and on explicit scalar paths. The nondeterministic family has a separate diagnostic contract. Historical observations retain their own macOS ARM binary identity, input hash, 48 default repetitions with multiple hashes, and 12 stable single-thread controls per source format. The current oracle is independently checked against its build metadata, upstream lock and configure flags; it need not have the historical binary's SHA. Fresh observations record both identities and `sameReferenceBinary` in compat/reports/inverse-instability.json and the differential log. Fresh runs do not assert that a probabilistic race must reproduce on every invocation. Historical instability is not automatically attributed to a different artifact; that condition requires its own evidence.

## Resources, provenance and evidence

`pixelConversionStateBytes` accepts an optional fifth arithmetic-profile argument. Generic inverse state includes the horizontal/vertical coefficient tables, bounded row workspace and two Int32 chroma rows. CLI preflight adds this bound to the existing input/output frame reservations. Library maxStateBytes, cancellation, positive padded strides, owned output and bigint PTS retain the existing conversion contract. No full intermediate image, native process, remote transcoder or implicit scalar fallback is used. Observed heap/CPU and production Workers measurements remain incomplete.

The adapted inverse.ts component is LGPL-2.1-or-later, with source/author notices in [NOTICE](../../packages/swscale/NOTICE) and the inherited [license text](../../packages/swscale/LICENSES/LGPL-2.1-or-later.txt). It traces the fixed upstream yuv2rgb.c, output.c and AArch64 implementations. The generic chroma coefficient component retains its previous adapted provenance. Project-wide license selection/audit remains open.

Evidence comprises 2128 strict default raw/framecrc comparisons and 560 explicit scalar comparisons across the thirty-five format pairs, tiny/odd/even/aligned geometries, scoped timing and two output formats. Default aligned semiplanar cases are excluded from the bit-exact contract and instead have twenty-eight pre-I/O rejection checks, sixteen fresh native diagnostic repetitions, and the recorded forty-eight repetitions per format plus twelve single-thread controls per format. Unit anchors cover the one-byte table/NEON difference, two-tap alpha at borders, full chroma precision, unknown/large PTS, padded planes, state budgets and the explicit rejection. The actual launcher compares twelve outputs and the rejection. Local workerd compares six scoped numeric-profile cases with three-byte reads; isolated R2 verifies staged YUV420P-to-RGBA bytes and cleanup. Full compatibility, other matrices/ranges, arbitrary scaling, compressed video and canonical/production runtime conformance remain unverified.

## Geometry-changing inverse conversion

The fused resize API now handles all six YUV inputs to all seven RGB outputs with explicit aarch64/scalar/x86_64 profiles. See [resized inverse arithmetic and evidence](pixel-resize.md). Its filtered path is separate from the unscaled native dispatch described here; existing unchanged-size guards remain in force.
