# FLAC stream-copy duration evidence

This corpus records 38 independently executed Native FFmpeg commands for a single FLAC input and output, `-c:a copy`, and input/output `-t` or `-to` without nonzero seeking. It is scoped evidence, not a declaration of general FFmpeg compatibility.

The reference is FFmpeg 9.0.2 commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, Darwin arm64 binary SHA-256 `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`. Build metadata is retained in `cases.json`; Linux/compiler portability is not certified.

The existing canonical input is selected from `flac-max-remux/cases.json`, not inferred from its name. Its STREAMINFO declares 8,000 Hz, stereo signed 16-bit, 257 samples. Independently recorded complete compressed packets have sample timestamps 0 and 192, and durations 192 and 65. The unknown-total derivative clears only the STREAMINFO total-sample bits; the empty input is the separately recorded canonical empty source. Every row embeds its exact input and output bytes and hashes, virtual argv, exit status, stdout, and normalized stderr. Output packet membership is independently verified against recorded original compressed packet sizes and hashes; expected output bytes are never synthesized.

Observed behavior:

- Input and output duration both include a complete packet when its timestamp is strictly below the duration. A duration immediately below, equal to, and immediately above 24,000 microseconds yields one, one, and two packets. Other rows cover zero, one sample, the final sample, and before the boundary.
- `-t 0` succeeds with a metadata-only output. `-to 0` fails because the end time is not after the zero start. Negative `-t` fails.
- `-t` takes precedence over `-to` in the same option group. Independent input/output durations intersect; frame limits intersect with duration.
- Truncation preserves the source STREAMINFO totalSamples, including metadata-only outputs. Unknown totals remain unknown. Native default metadata and bitexact/metadata-stripped output are recorded separately.

There are 34 successful copy commands and four Native errors. One additional Native preparation command encodes existing independently captured s16le PCM at 44,100 Hz with a 192-sample frame size. Its complete input/output, argv, stdout/stderr, hashes, and independent packet inspection are retained in `sourcePreparation`. The second packet starts at 192/44,100 seconds (4,353.741… microseconds). Measured output durations 4,353, 4,354, and 4,355 microseconds produce one, one, and two packets: the packet timestamp rounds to 4,354 microseconds before the strict duration comparison. No claim is made about nonzero seeking, multiple outputs, discontinuities, or rewritten duration metadata.

Run `node tools/differential-runner/flac-copy-duration/generate.mjs --verify` for cache validation without Native execution. Generation is sequential, capped at 40 Native calls and 512 KiB per input/output. The initial 31 rows, incremental four boundary rows, one fractional-rate source preparation, and three fractional boundary rows consumed 39 total Native calls; the final verification consumed zero. Completed rows are persisted after every execution, and cache reuse validates argv and input/output hashes. An incremental fingerprint history preserves the initial capture rather than discarding or re-executing it.

Public acceptance now compares all 34 successful commands with exact output
bytes using an unconfigured decoder backend and a 2 MiB resident budget. The
actual Node launcher also runs without `--flac-wasm`. Local R2/workerd uses
`missing-module` mode to verify the same copy route and checks cancellation,
write failure and output-budget failure preserve an existing committed object.

The four captured invalid-duration commands retain Native exit status 234.
Public tests assert rejection and no output publication; they do **not** claim
matching Native process exit codes or diagnostic text. That CLI error
compatibility remains a separate open item.
