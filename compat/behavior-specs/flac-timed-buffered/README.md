# FLAC time selection with finite buffering filters

This corpus records 24 independent successful Native FFmpeg 9.0.2 executions,
commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, executable SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
Every command specifies `-cpuflags 0`; the pinned Wasm hash is stored alongside
these reference pins.

Canonical 8 kHz stereo 257-sample 16-bit and 24-bit ramp inputs are reused from
`flac-decode-cli`, with STREAMINFO validation. Each of twelve plans has a
known-total input and an unknown-total counterpart differing only in the
36-bit total-samples field. No preparation executes Native.

Finite `apad=pad_len=64` and `whole_len=200`/`400`, plus
`asetnsamples=n=64:p=0`/`p=1`, are combined with input `-t`/`-to` and output
`-ss`/`-t`/`-to`. Cases include a window entirely in appended silence, a
0.0005-second input followed by padding, output zero duration, volume and
singleton aformat chains. Outputs cover raw integer/float PCM, WAV, AIFF, AU
and framecrc; one framecrc case limits output to two audio frames.

The pinned `fftools/ffmpeg_filter.c` constructs input trim before the user
filter chain, then appends encoder-format constraints and output trim
(`configure_input_audio_filter` around lines 1960–2006; output audio setup
around lines 1777–1810). Its output `-apad` option is also inserted before
output trim, but this corpus exercises explicit finite apad filters in `-af`,
not the CLI `-apad` option. All rates remain 8000 Hz: no rate-changing or
unbounded-padding behavior is implied.

Captured framecrc demonstrates retained post-filter boundaries: the
aset-p0-window output has frames of 23, 64, 64 and 10 samples, while the
aset-frame-limit output stops after frames of 23 and 64 samples. Outputs are
actual Native bytes, not inferred from counts or constructed checksums.

Each row retains input/output bytes and SHA-256 values, argv, exit status,
stdout and stderr with temporary paths normalized. Expected PCM is never
synthesized and no tolerance is used. Native success is not itself a runtime
compatibility claim; public Node/Workers tests compare these captured outputs.

```sh
node tools/differential-runner/flac-timed-buffered/generate.mjs --verify
```

Initial generation used 24 Native calls, zero preparation calls, within a
32-call cap. Verification validates cached pins, argv and hashes with zero
Native executions. Without `--verify`, missing rows can be saved incrementally.
Each command has a 10-second timeout; individual inputs and outputs are bounded
to 512 KiB.


## Runtime acceptance scope

Public API and local R2/workerd acceptance compare all 24 captured Native
outputs exactly; an actual Node CLI launcher case also compares captured
bytes. This scope is limited to unchanged-rate finite buffering filters.
Four negative policy controls retain explicit rejection boundaries; these are
not Native error-parity claims. Three R2 fault controls exercise cancellation
during write, write failure and output budget exhaustion, preserving the prior
committed output with no staging or multipart remnants.
