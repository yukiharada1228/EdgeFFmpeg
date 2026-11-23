FLAC time-option Native evidence

Scope
  63 sequential invocations: 21 scenarios, each with s16le PCM, WAV and
  framecrc output. Before/after -i placement, repeated -ss/-t/-to, zero and
  tiny durations, negative -t/-to, seeks beyond EOF, and mixed input/output
  ranges are covered. Every row includes virtual argv, actual exit status,
  output bytes or null, hashes, normalized stderr, source provenance,
  selected audio stream ID and STREAMINFO-derived descriptor metadata.
  selectedStreamIds records the explicit -map 0:a:0 selection request;
  selectionVerified is false when Native rejects the command before encoding.

Reference
  FFmpeg commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
  Exact binary SHA-256:
    1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92
  This is the existing darwin/arm64 development oracle, not the target
  Workers runtime or a pinned reproducible Linux toolchain. reference retains
  that build's metadata and platform limitations. wasmSha256 identifies the
  existing Wasm artifact only; this generator does not execute Wasm.
  Invocation prefix is stored separately from each row's virtual argv.

Source
  compat/behavior-specs/flac-decode-cli/cases.json, 16-2-ramp-5/s16le.
  Clean 8 kHz stereo signed 16-bit FLAC, 257 samples, 192-sample blocks.
  Input and canonical PCM SHA-256 are checked before any Native execution.
  No production helper is imported and no fixture input is synthesized.

Observed results
  45 commands succeed; 18 reject invalid negative durations or zero/negative
  stop times with exit code 234. Rejected outputs are absent, not empty PCM.
  Repeated output -ss/-t keeps the last value (64..144 samples); repeated
  output -to produces samples 64..200. A later positive -t overrides an
  earlier negative -t before validation (40 samples in the combined case).
  Input -t 0 and input -t 0.000001 both retain all 257 samples. Output -t 0
  emits zero samples; output -t 0.000001 emits the first 192-sample frame.
  Output -ss 0.008 emits samples 64..257. Beyond-EOF seeks emit no samples.
  On this exact short canonical source, positive input -ss warns "could not
  seek" and emits no samples, including the mixed input/output scenario.
  This surprising behavior is preserved rather than replaced with a decoded
  slicing assumption. Mixed input -t/-to emits the Native precedence warning.
  The source does not characterize successful input seeking on longer FLACs.

Validation and regeneration
  From repository root:
    node --check tools/differential-runner/flac-max-time/generate.mjs
    node tools/differential-runner/flac-max-time/generate.mjs --verify
  Initial generation uses the same script without --verify. Matching captured
  data is validated and reused with zero Native calls, even without --verify.
  A changed identity is rejected rather than silently regenerating evidence.
  Validation checks per-row identity/hashes, bounds, PCM contiguous slices,
  WAV payload agreement, and framecrc sample-duration agreement.
  Native invocations have a ten-second timeout and bounded diagnostic capture;
  all inputs and outputs are below 512 KiB. Temporary files live exclusively
  under .build/temp/flac-max-time-* and are removed on completion/failure.
  Publication uses a temporary completed JSON and atomic rename.

Remaining work
  These are independent Native observations, not production compatibility
  passes. Production time integration and differential tests are coordinator
  work; no production code, shared files or tests were changed here. The full
  22-chapter architecture remains the target, not a claim established by this
  focused corpus. Successful long-input seeks, negative -ss, alternate rates,
  other bit depths/layouts, pictures and stream-copy time semantics remain
  outside this corpus. The earlier flac-max-trim generator is left untouched.
