# FLAC bounded audio-filter Native evidence

Development-only evidence generated independently of production helpers by
`tools/differential-runner/flac-max-filters/generate.mjs`.

Run from the repository root:

    node tools/differential-runner/flac-max-filters/generate.mjs
    node tools/differential-runner/flac-max-filters/generate.mjs --verify

An unchanged fingerprint validates existing evidence without invoking Native.
The generator pins the exact ffmpeg SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`,
checks the locked upstream commit and six filter sources against Git, and records
the current verified FLAC Wasm artifact hash as provenance. Wasm is not executed
by this generator. Reference build metadata retains its actual Darwin/arm64
platform and non-reproducible-toolchain qualification.

## Coverage

There are 64 sequential Native invocations: 30 valid filter scenarios each
producing signed 32-bit little-endian PCM and framecrc, plus four invalid-grammar
PCM invocations. No production imports, source synthesis, installations, native
builds, or network calls are used. Canonical FLAC inputs are reused verbatim from
`compat/behavior-specs/flac-decode-cli/cases.json`; each row records its source row,
input hash, selected stream ID and STREAMINFO descriptor. The canonical sources
include empty input, a 16-bit ramp and 24-/32-bit extremes.

Scenarios cover anull; all combinations of volume 0.5/0/2/6dB and
fixed/float/double precision; asetrate 4000/16000; aformat s16/fltp/dblp;
asetnsamples padded/unpadded/default-padding; and finite apad sample lengths,
minimum lengths, durations, packet sizes and empty input. All successful outputs
use pcm_s32le, allowing raw bytes to be checked against the exact packet sizes and
Adler checksums in framecrc. Framecrc also preserves Native packet timestamps,
durations and sample-rate headers.

Unknown volume precision, zero asetrate, unknown aformat and conflicting apad
lengths retain their actual nonzero exit codes and diagnostics. They are errors,
not substituted successful outputs. Runtime addresses and transient paths in
stderr are normalized explicitly; PCM/framecrc bytes are unmodified. Diagnostic
prefixes and invocation-wide defaults are recorded separately from virtual-path
row args. Output-file absence and empty output are distinct.

## Bounds and publication

Inputs and each output are limited to 512 KiB; diagnostics are bounded and each
Native invocation has a 10-second timeout. A defensive output-size option is
included in every recorded command. Inputs in this corpus are at most 10,050
bytes and outputs at most 3,072 bytes, well below that cap. All apad plans have
finite lengths/durations; no unbounded apad is invoked. Native work is sequential
with one decoder/filter thread, at most 64 invocations. Transient inputs/outputs
are under `.build/temp/flac-max-filters-*` and removed in a finally block. The
fixture is published by rename; actual Native failures are retained even when
subsequent semantic validation fails.

## Verified observations and remaining gaps

The captured run returned 60 successes and four expected errors. Sample counts
include 257 for unpadded input; 320 for asetnsamples n=64 with padding; 384 for
n=192 with default padding; 264 for apad pad_len=7; 300 for whole_len=300; 259 for
pad_dur=0.00025 at 8000 Hz; and seven samples for finite apad on empty input.
asetrate changes the output rate to 4000/16000 without changing the 257 samples.

These are Native expectations, not a claim that the production backend conforms.
No production implementation, integration test, Core memory reservation,
cancellation path or atomic production-output publication was changed or tested
here. The coordinator must integrate and compare these rows with the real
Workers TypeScript/Wasm pipeline after the helper wave. In particular, empty
input plus finite apad must be compared explicitly rather than assuming that
empty input always produces empty output.

This bounded corpus does not complete the 22-chapter architecture goal. It does
not establish general filtergraph/expression support, arbitrary sample formats
or layouts, resampling negotiation, unbounded padding support, every malformed
grammar, or equivalence across other compilers/architectures. Unsupported
production grammar must remain an explicit error; do not infer support from a
Native success or silently pass through an unimplemented filter.
