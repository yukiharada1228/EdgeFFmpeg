# Output-side FLAC trimming: pinned Native evidence

`cases.json` contains 64 sequential Native invocations: 16 output-option boundary plans crossed with packed raw PCM, planar PCM requested in the raw muxer, packed framecrc, and planar framecrc. No production implementation or production helper is imported by the generator. This is development-only evidence, not a production fallback or a claim of backend integration.

Reference binary SHA-256: `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
Upstream commit: `946fcce07b6dcd0331c8cc609192aeff5e1924f8`.
Wasm artifact SHA-256: `d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f`.
The full reference metadata records the actual Darwin arm64 development oracle, including its non-Linux/non-reproducible-toolchain limitations. Wasm is hashed for provenance only; it is not run by this generator.

Inputs are the unchanged, hash-verified clean canonical rows `16-2-ramp-5/s32le`, `24-2-extremes-5/s32le`, and `32-2-ramp-5/s32le` in `compat/behavior-specs/flac-decode-cli/cases.json`. All are stereo 8000 Hz, 257 samples, with decoded-frame boundaries at sample 192. Input source row IDs, input hashes, canonical decoded-output hashes, selected stream IDs `[0]`, and STREAMINFO-derived descriptors accompany every row. Time options appear after `-i`, so these are output trims, not input seeking.

Coverage includes exact one-sample positions, times before/at/after a nominal half sample, exact decoded-frame positions, half-after-frame end boundaries, a three-sample range crossing decoded frames expressed with both `-ss/-t` and `-ss/-to`, a 24-bit last sample, and a 32-bit exact-frame duration.

Actual outcomes:

- 48 Native successes: 16 packed raw outputs and 32 packed/planar framecrc outputs.
- 16 retained Native failures: `pcm_s32le_planar` is rejected by the `s32le` raw muxer, with actual exit code 234, diagnostic text, and empty output retained. These are intentional compatibility evidence, not successful planar raw output.
- Successful raw output bytes match contiguous slices of canonical Native PCM. First/last stereo sample values and slice bounds are stored.
- Framecrc output text is preserved byte-for-byte, including Native time bases, DTS, PTS, durations, and checksums. Per-packet first/last sample values for both layouts are independently established from the successful packed Native PCM, with packet-local planar rearrangement checked against each Native Adler-32 checksum. `sampleEvidenceSource` identifies that derivation; planar PCM bytes were not obtained from the failing raw muxer.
- Observed rounding is not idealized sample arithmetic: `-ss 0.0000625` retains all 257 samples, whereas `-ss 0.000063` retains 256. `-t 0.0000625` and `-to 0.0000625` each retain the first 192-sample decoded frame. Half-after-frame duration/end cases retain 192 samples. Preserve these differences in implementation tests.

Run from repository root:

    node tools/differential-runner/flac-max-trim/generate.mjs --verify

Matching evidence is validated without additional Native calls. Missing or changed evidence requires omitting `--verify`; generation uses at most 64 sequential calls. Sample annotations can be added to already matching cached evidence without rerunning Native. Temporary inputs, outputs, and atomic-publication staging live only under `.build/temp` and are cleaned in `finally`. Each actual input/output is bounded to 512 KiB; the largest recorded input is 9529 bytes and largest output 2056 bytes. The combined JSON is larger because canonical inputs are repeated per schema.

Limitations: this task does not implement or test production trimming, memory ownership, cancellation, or atomic production publication. It does not demonstrate general FLAC, all sample rates/channel layouts, negative or malformed times, `-t/-to` precedence, input seeks, EOF/zero-duration behavior, all PCM encodings/muxers, or full 22-chapter compatibility. Broader backend integration and Workers/Wasm differential checks remain coordinator work. No fixture expectations were adjusted to conceal Native differences.
