# FLAC time selection with scalar resampling

This corpus records 32 independent successful invocations of the pinned Native
FFmpeg 9.0.2 executable (commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`).
The executable SHA-256 is
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
Every invocation explicitly supplies `-cpuflags 0`; this is scalar-profile
evidence, not evidence for all CPU dispatch profiles.

The existing `flac-decode-cli` corpus supplies canonical stereo 8 kHz, 257-sample
16-bit and 24-bit ramp inputs. Generation verifies the STREAMINFO fields. Each
plan has a known-total input and an otherwise identical unknown-total input:
only the STREAMINFO total-samples 36-bit field is cleared. No new Native source
preparation or synthetic output derivation was needed.

Sixteen plans cover output rates 11025, 48000 and 4000 Hz, input `-t`/`-to`,
output `-ss`/`-t`/`-to`, zero duration, short input, past EOF, near EOF, mixed
input/output limits, `anull` and simple `volume` chains. Fractional output starts
such as `0.005123` exercise selection after the resampler has consumed the
preceding input history. Input duration is applied before resampling. Outputs
include raw s16le, WAV, AIFF and AU. Rate-changing framecrc packet boundaries,
nonzero input seeks and buffering filters are not covered by this corpus.

`cases.json` stores exact input/output bytes, SHA-256 values, argv, exit status,
and normalized stdout/stderr for every invocation. No tolerance or expected
output rewriting is used. Platform/compiler rounding outside this pinned
scalar profile is not certified.

From the repository root:

```sh
node tools/differential-runner/flac-timed-rate/generate.mjs --verify
```

Verification reuses all 32 captured rows and executes zero Native processes.
Without `--verify`, generation can append missing rows after validating cached
pins and content. The initial capture used exactly 32 Native calls, no
preparation calls, within the 40-call cap. Each process has a 10-second timeout;
each individual input/output is bounded to 512 KiB. Existing rows are retained
incrementally after each successful invocation.

## Backend integration

The public FLAC backend now applies input recording duration before FIR and
output seek/duration after FIR, at each scope's sample rate. It uses actual
resampler EOF for finite lengths, including short-input drain, and retains
source prefix samples for output seeking. Same-rate behavior remains unchanged.
`-cpuflags 0` is required for changing-rate conversion. This corpus covers
`anull` and constant `volume`; singleton aformat with changing rates now has
separate [evidence and acceptance limits](../flac-aformat-rate/README.md).
Finite buffering filters at unchanged rates have separate
[evidence](../flac-timed-buffered/README.md). Buffering filters and `asetrate`
in the timed changing-rate path remain unsupported. Singleton aformat at unchanged rates has separate
[evidence](../flac-timed-aformat/README.md). Changed-rate framecrc and decoded
frame limits still reject.

Public integration and actual Node CLI acceptance compare exact captured
outputs. Local R2/workerd without Node compatibility covers all 32 rows,
five rejection controls and three cancel/write/budget controls that preserve
a committed output with no staging/multipart remnants. These checks do not
promote full-project conformance or cross-platform arithmetic equivalence.
