# Pinned Native same-rate FLAC remix evidence

The complete matrix now contains 60 successful rows: 16/24/32-bit ramp/extrema,
mono to stereo and stereo to mono, integer/float raw PCM plus 24 framecrc rows.
Inputs/outputs are bounded to 512 KiB, calls are sequential, and raw bytes,
timestamps, sample counts, packet sizes and Adler checksums are validated.
The pinned FFmpeg commit and Native/Wasm hashes remain in `cases.json`.

The coordinator completed the missing coverage with 57 new Native calls: 55 new
outputs and two mono-extrema source derivations. All five saved output rows and
the saved32-bit mono derivation were verified and reused without execution.
The current generation's64-call ceiling was respected. The retained matrix
represents60 outputs plus three derivations; `generationHistory` separately
preserves the earlier failed task's actual66 calls, including60 discarded calls
and its exceeded64-call cap. Those earlier failures are not erased or relabeled.

`arithmetic.json` records three further independent executions: default and
`-cpuflags 0` float contraction probes, and one full scalar FLAC remix output.
Both probes identify the pinned Clang build as `fused`; CPU flags do not disable
compiler floating contraction. Tests explicitly configure this observed profile.
The separate profile remains available; default-profile differences are not
hidden by changing expected output bytes or ignoring float32/framecrc rows.

Production backend callers can configure `remixArithmetic: 'fused'` globally or
inside the FLAC configuration. The Node launcher forwards its existing
`EDGEFFMPEG_REMIX_ARITHMETIC=fused` setting. Scalar-sensitive public conversions
still require `-cpuflags 0`. General floating bit-exactness is not certified.

Verification and cache reuse (zero Native calls):

    node tools/differential-runner/flac-max-remix/generate.mjs --verify
    node tools/differential-runner/flac-max-remix/probe-arithmetic.mjs

The original full generation failed when a32-bit mono derivation silently
became24-bit. The corrected encoder uses `-strict experimental`; the failed
60-call output was not retained and cannot be claimed as evidence. A selected
six-call retry published only five rows. The subsequent coordinator continuation
above filled the remaining scope rather than weakening the60-row acceptance gate.

Node and actual local R2/workerd helper acceptance now compare all60 rows using
the pinned contraction profile, including real Core reservations, borrowed-frame
lifetimes, fragmented output, cancellation and transaction cleanup. Public
backend/Node launcher/Workers tests additionally exercise explicit profile
propagation. This is scoped evidence, not full22-chapter implementation,
cross-platform certification, remote Cloudflare deployment or a general numerical
compatibility guarantee. Native execution is development-only.
