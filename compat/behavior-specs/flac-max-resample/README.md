# FLAC finite resampling Native evidence

Development-only oracle; no production helper imports or runtime fallback.

Run from the repository root:

    node tools/differential-runner/flac-max-resample/generate.mjs
    node tools/differential-runner/flac-max-resample/generate.mjs --verify

The first capture made 62 sequential Native calls: two FLAC source preparations and 60 output captures. An identical fingerprint reuses and validates the existing evidence with zero Native calls. `--verify` never regenerates. Scratch files live under `.build/temp/flac-max-resample-*` and are removed in `finally`; `cases.json` is published by rename only after validation.

Reference binary SHA-256: `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
Reference upstream commit: `946fcce07b6dcd0331c8cc609192aeff5e1924f8`.
Wasm artifact SHA-256: `d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f` (identity only; this generator does not execute Wasm).

All rows have explicit `-map 0:a:0`, selected stream ID 0, parsed FLAC STREAMINFO descriptors, explicit `pcm_s16le`, and outputs in raw s16le, RIFF WAV, or framecrc. Every row retains input/output bytes and hashes, actual exit code, normalized stderr, argv using `/in.flac` and `/out`, source provenance, output rate, and sample count. `invocationPrefix` records the exact common options supplied to Native. Only transient paths and nondeterministic diagnostic pointer addresses are normalized.

Canonical sources are the empty and 257-sample stereo 16-bit 8 kHz inputs from `flac-decode-cli/cases.json`. Source preparation reuses the canonical decoded PCM: a 16-sample prefix is encoded as FLAC at 8 kHz; the entire 257-sample ramp is reinterpreted at 48 kHz and encoded without resampling. Preparations retain their own PCM bytes/hash, exact argv, output hash, exit code and stderr in `sources`. This supplies genuine downsampling without claiming an 8 kHz source downsamples to 8 kHz.

Observed EOF-drained samples per channel (raw/WAV/framecrc agree):

| Input | 8000 | 11025 | 16000 | 44100 | 48000 |
|---|---:|---:|---:|---:|---:|
| Empty, 8000 Hz | 0 | 0 | 0 | 0 | 0 |
| Ramp 257, 8000 Hz | 257 | 355 | 514 | 1417 | 1542 |
| Short 16, 8000 Hz | 16 | 0 | 0 | 0 | 0 |
| Ramp 257, 48000 Hz | 43 | 59 | 86 | 237 | 257 |

All 60 captures exited 0. The 27 empty-output rows retain Native warnings, including the 16-sample inputs that yield no samples when resampled. Do not replace these outputs with duration-rounded expectations.

Framecrc preserves Native packet timestamps, durations, byte counts, checksums, packet count and final packet sample count. For the 8 kHz ramp, upsampling to 11025/16000/44100/48000 produced packet durations `[243,90,22]`, `[352,130,32]`, `[971,358,88]`, `[1056,390,96]`. At 48 kHz input, downsampling to 8000/11025/16000/44100 produced `[27,16]`, `[43,16]`, `[69,17]`, `[220,17]`.

Bounds: each input/output is capped at 512 KiB; observed maxima were 8798 input bytes and 6246 output bytes. Stdout/stderr buffering and per-call time are bounded. Cross-container validation compares raw PCM bytes to WAV data and checks all sample counts against framecrc.

Limitations: captures observe CLI EOF drain, not direct `swr_convert` pre-flush/post-flush calls. Final packet counts are observable Native packetization, not a claim that every final packet is exclusively flush output. This corpus does not certify production resampling byte parity, Core reservation/cancellation/atomic-output behavior, other PCM precisions/layouts, arbitrary input rates/lengths, or the full 22-chapter architecture. Main backend integration and broader conformance remain coordinator work. Reference metadata itself records an unpinned reproducible toolchain and a platform mismatch; the exact existing binary is pinned rather than claiming a reproducible cross-platform build.

## Explicit scalar reference

`scalar.json` retains 60 additional independent Native executions with `-cpuflags 0`, captured by `tools/differential-runner/flac-max-resample/scalar.mjs`. The original Default captures remain unchanged. Exactly 24 outputs differ between the two profiles (eight ramp conversions in three containers); input identities, sample counts and packet schedules remain checked. Helper, public Node and local workerd/R2 acceptance use the explicit scalar reference. Changed-rate public framecrc remains explicitly unsupported because packet boundary parity is not established.
