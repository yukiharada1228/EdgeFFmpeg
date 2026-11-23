# FLAC singleton identity aformat constraints

This corpus records 16 independent successful Native FFmpeg 9.0.2 executions,
commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, executable SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
All commands explicitly select `-cpuflags 0`. The Wasm artifact hash is retained
in `cases.json` alongside the reference pins.

The existing `flac-decode-cli` corpus supplies canonical stereo 8 kHz,
257-sample, 16-bit and 24-bit ramp FLAC inputs. STREAMINFO is validated.
Known/unknown-total pairs differ only in the 36-bit total-samples field.
No source preparation uses Native execution.

Eight plans cover identity singleton `sample_rates=8000` / `r=8000` and
`channel_layouts=stereo` / `cl=stereo`, alone and together, with optional s16/dbl
sample-format constraints. They include input duration, fractional output time
windows, volume before/after aformat and zero output duration. Raw s16le/f64le,
WAV, AIFF and AU outputs use explicit final PCM codecs. These are identity rate
and layout constraints: no changed-rate or channel-remix behavior is implied.

The option aliases are verified against pinned
`upstream/ffmpeg/libavfilter/af_aformat.c` lines 60–66. Its query_formats uses
common input/output sample-rate and channel-layout lists (lines 120–127),
which lets identity constraints pass through without requiring a rate change
or remix. General negotiation and multi-candidate lists remain outside scope.

Each row stores exact input/output bytes and SHA-256 hashes, argv, exit status,
stdout and stderr. Temporary paths are normalized. Expected outputs are real
Native results without numeric tolerances or synthesized PCM. Native success
alone is not a runtime compatibility claim; Node and Workers acceptance must
compare the stored outputs independently.

```sh
node tools/differential-runner/flac-aformat-constraints/generate.mjs --verify
```

Initial generation used 16 Native calls, no preparation calls, within the
24-call cap. Verification validates cached pins, arguments and hashes with
zero Native executions. Without `--verify`, missing rows are saved
incrementally. Each command has a 10-second timeout and each input/output is
bounded to 512 KiB.


## Backend acceptance scope

Public Node and local R2/workerd acceptance compare all 16 captured outputs
exactly. An actual Node CLI launcher case also compares captured bytes. Eight
negative policy controls now cover the four mismatching constraints
(`sample_rates=16000`, `r=16000`, `channel_layouts=mono`, `cl=mono`) and four
additional rate/layout mismatches with output `-t 0` or `-frames:a 0`. These
additions require metadata preflight even when no frames are requested, before
output publication. Post-fix acceptance passes all 27 tests, including these
zero-duration/zero-frame preflight checks. R2/workerd
additionally exercises cancellation during write, write failure and output
budget exhaustion: each preserves the prior committed output and leaves no
staging or multipart remnants. These mismatch controls are rejection-policy
checks, not Native error-parity claims.

The four previously rejected identity-constraint rows in the
[timed-aformat corpus](../flac-timed-aformat/README.md) are also promoted to exact
Node/R2 output comparisons. General constraint negotiation, changed-rate
constraints and channel remix remain unsupported by this identity scope.
