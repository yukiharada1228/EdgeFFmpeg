# FLAC singleton aformat with scalar rate conversion

This corpus captures 36 successful independent Native FFmpeg 9.0.2 executions,
commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, executable SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
All commands specify `-cpuflags 0`. The evidence certifies only the pinned scalar
profile, not other architectures, compilers or CPU dispatch paths.

Canonical stereo 8 kHz, 257-sample 16-bit and 24-bit ramps are reused from the
`flac-decode-cli` corpus after STREAMINFO validation. Known/unknown-total pairs
only differ in the 36-bit total-samples field. No Native source preparation is
needed. Eight untimed plans, eight timed counterparts and two short-input boundary
plans cover rates 11025,
48000 and 4000 Hz; singleton flt, fltp, s16, s16p, s32, dbl, dblp and u8
constraints; volume before/after aformat; input duration and output windows;
raw PCM, WAV, AIFF and AU. Final PCM codecs are explicit. Identity sample-rate/layout constraints inside
aformat have separate [evidence](../flac-aformat-constraints/README.md).
Rate-changing constraints inside aformat, alternative lists and channel remix
remain outside this corpus's scope.

Every actual Native command includes `-loglevel verbose`, retained in the
`referenceArgs` field. `args` contains the canonical command without this
reference-only diagnostic option, for runtime acceptance. This is output
compatibility evidence, not a claim that the runtime accepts the verbose
option. `stderr` retains the inserted graph/conversion diagnostics; temporary
paths are normalized, process addresses remain as captured.

The diagnostics distinguish format negotiation from a fixed filter-then-rate
pipeline. Matching packed filter/encoder formats can share one converter
before aformat that changes both rate and format. Planar-to-packed outputs
instead convert format at 8 kHz before aformat and change rate after it.
Volume before s16 places the rate-changing conversion between volume and
aformat; fltp before volume places it after volume. For timed u8 output, Native
can insert rate conversion before the input trim itself. The appended short-input s16 cases make this observable: 0.0005 seconds of
input duration produces 24 output samples per channel at 48000 Hz when rate
conversion precedes input trim. The fltp counterparts yield no samples because
format conversion is at 8000 Hz, trim precedes rate conversion, and the short
input cannot produce FIR output. Exact captured bytes, not an inferred
simplified ordering, are the acceptance oracle.

The pinned source explains these insertion opportunities:
`fftools/ffmpeg_filter.c` constructs an abuffer followed by input trim
(`configure_input_audio_filter`, around lines 1960–2006), and output aformat
constraints followed by output trim (around lines 1777–1810).
`libavfilter/avfiltergraph.c` negotiates link formats and automatically inserts
converters in `query_formats` (around lines 529–700), then reduces and picks
formats (around lines 1379–1388). This graph negotiation permits an inserted
converter before a trim even when the user did not specify one there.

`cases.json` retains input/output bytes and hashes, canonical and actual argv,
exit code and process logs. No tolerance, rewritten output, or synthesized
expected PCM is used. Native success alone does not establish runtime support;
Node/Workers acceptance tests must independently compare the captured bytes.

```sh
node tools/differential-runner/flac-aformat-rate/generate.mjs --verify
```

Initial generation used 32 Native calls. Four independently captured
short-input rows were appended without modifying those original captures,
bringing the total to 36 Native calls, zero preparation calls, within the
40-call cap. Cached verification validates pins, argv and hashes with zero
Native executions. Omit `--verify` only to incrementally capture missing rows.
Each process is limited to 10 seconds; each input/output is at most 512 KiB.


## Backend acceptance scope

Public Node and local R2/workerd acceptance compare 32 captured outputs exactly,
including the short-input cases that distinguish conversion before input trim
from conversion after it. They use the canonical `args`; the diagnostic-only
`referenceArgs` are not passed to the virtual CLI.

The four known/unknown `dblp-11025` and `dblp-mixed-11025` rows remain explicit
precision gaps for double-precision PCM output. The runtime guard rejects
these unsupported outputs rather than publishing differing samples. Their
successful Native captures remain unchanged and are not counted among the
32 compatibility successes. The precise cause of the observed difference has
not been established; no compiler, CPU or arithmetic explanation is asserted.
No tolerances or replacement expected bytes are used.

Identity rate/layout constraints that match the configured input are now
supported in a [separate scope](../flac-aformat-constraints/README.md).
Rate-changing constraints and general layout negotiation remain limited.
This scope does not establish general aformat negotiation, channel conversion,
rate-changing framecrc packet scheduling, or full-project conformance. The
[unchanged-rate aformat corpus](../flac-timed-aformat/README.md) and
[time-plus-rate corpus](../flac-timed-rate/README.md) retain their separate
coverage and rejection boundaries.
