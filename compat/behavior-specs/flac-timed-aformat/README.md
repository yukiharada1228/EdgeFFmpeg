# FLAC time selection with singleton aformat constraints

This corpus records 36 independent successful invocations of Native FFmpeg
9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, executable SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
Every argv supplies `-cpuflags 0`; no other CPU dispatch profile is certified.

Canonical stereo 8 kHz, 257-sample 16-bit and 24-bit ramp FLAC sources are reused
from `flac-decode-cli`. Their STREAMINFO fields are checked before generation.
Each of 18 plans has a known-total input and an unknown-total counterpart made
by clearing only the 36-bit STREAMINFO total-samples field. Source preparation
uses zero Native calls.

Sixteen format-only plans (32 rows) exercise singleton `aformat=sample_fmts=...` for u8, s16, s32, flt and
dbl, both packed and planar. They cover constraints before and after volume,
input `-t`/`-to`, fractional output `-ss`/`-t`/`-to`, mixed limits, empty input,
zero output and past EOF. The u8-volume-roundtrip case intentionally preserves
Native's implicit format conversion behavior; expected bytes are never
synthesized. Explicit final PCM codecs separate filter format from encoder
format. Outputs include raw integer/float PCM, WAV, framecrc, AIFF and AU.

The four original s16-aiff/dbl-au known/unknown rows additionally constrain the singleton
sample rate to 8000 and layout to stereo. These four rows are now accepted
as identity constraints and compare exactly, bringing this corpus to 36
supported captured outputs. The appended
s16-aiff-format-only/dbl-au-format-only pairs remain separately captured outputs
without those constraints; the original 32 captures are unchanged. General
format negotiation, lists of alternatives and nonzero input seeks remain
outside this corpus's scope. Changed-rate sample-format handling has separate
[evidence](../flac-aformat-rate/README.md).


`cases.json` retains exact input/output bytes, SHA-256 values, argv, exit code,
stdout and stderr with temporary directory names normalized. There are no
numeric tolerances and no expected-output rewriting.

Verify from the repository root:

```sh
node tools/differential-runner/flac-timed-aformat/generate.mjs --verify
```

The initial capture used 32 Native calls; appending the four format-only
AIFF/AU rows used four additional calls. The total is 36 calls, no preparation
calls, within a 40-call cap. Verification executes zero Native processes and validates all
cached pins, argv and hashes. Missing rows can be captured incrementally by
omitting `--verify`. Each process has a 10-second timeout; individual inputs
and outputs are bounded to 512 KiB.

## Backend integration

Time selection now admits singleton `aformat=sample_fmts=…` (including its
existing `f=`/positional aliases), with `anull` and constant `volume`, when the
output sample rate is unchanged. Packed/planar u8, s16, s32, flt and dbl are
covered. Singleton aformat with changed rates now has separate
[evidence and acceptance limits](../flac-aformat-rate/README.md). Bare
unconstrained aformat and multiple candidate formats remain unsupported.
Singleton sample_rates/r and channel_layouts/cl are admitted when they match
the configured input rate and layout; general negotiation remains unsupported.
See the [identity-constraint corpus](../flac-aformat-constraints/README.md).
Existing scalar-rounding requirements and pre-allocation Core accounting remain
in force.

Public integration and actual Node CLI acceptance compare all 36 supported
Native outputs byte for byte. Local R2/workerd without Node compatibility also
compares actual stored bytes; six unsupported-policy controls and three
cancel/write/budget controls preserve existing output and leave no staging or
multipart remnants. Finite buffering filters at unchanged rates now have separate
[evidence](../flac-timed-buffered/README.md); changing-rate buffering remains
unsupported. The negative controls cover changing-rate buffering/scheduling, alternative formats,
mismatching rate/layout constraints and unsupported timed filters. The former
four Native-success identity-constraint gaps are now exact-output successes.

The retained case label `s16-empty-input` denotes input `-t 0` on the nonempty
257-sample source, not a physically empty FLAC file. In this decoded path Native
input `-t 0` disables duration trimming and produces all257 samples. Output
`-t 0` separately produces no samples. Exact recorded lengths remain the
source of truth; labels are not used to infer input/output sample counts.
