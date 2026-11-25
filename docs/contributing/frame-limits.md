# PCM output frame-count limits

The single-audio-stream CLI accepts output `-frames:a`, `-frames:a:0`,
`-frames:0`, `-frames` and the `-aframes` alias. The last matching option wins.
Counts use decimal signed 64-bit integers and bigint arithmetic: zero commits
an empty output, positive counts cap output packets, and negative counts mean
unlimited. Unsupported stream selectors and input-scoped frame options fail
explicitly. Decimal fractions, expressions and nondecimal number syntax are
outside the current parser profile.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -frames:a 2 -c:a copy -bitexact -f framecrc /first-two.crc
```

A PCM sample frame (one sample for every channel) is distinct from an encoded
output audio frame/packet. The implementation models the pinned native default
PCM packet span: the largest power of two at most sampleRate/10, with a minimum
of one sample. An output seek can shorten the first re-encoded packet; copy
selects whole packets and retains the timestamp offset. Duration options can
shorten the final packet. The frame-count cap applies to these semantic packets,
independently of physical read/write buffer sizes. Selection is calculated
before streaming, so no whole native packet needs to be held in memory.

The limit is shared by WAV, raw PCM and framecrc outputs. Zero-frame raw output
performs no PCM data reads even for a declared input larger than number precision.
Header reads and output headers are still required where the format needs them.
The input must still be a valid supported finite PCM stream.

Differential evidence covers 240 native scenarios and two Edge I/O budgets:
raw/WAV input, 10/8000/44100 Hz, seek/duration interactions, copy/PCM24 encoding,
zero/one/two/unlimited/int64-max counts. Alias/precedence tests compare raw bytes
and WAV sample payloads/durations. Workerd verifies a one-packet copy limit
with eight-byte reads and that no subsequent input packet is read.

The native parse of a count depends on the reference CPU. fftools `parse_number`
reads it as a double and rejects `(int64_t)d != d`. A count whose double is 2^63
(9223372036854775296 through 9223372036854776832) makes that cast undefined:
AArch64 saturates to INT64_MAX and accepts the count, while x86-64 returns
INT64_MIN and rejects it with `Expected int64 for frames:a but found ...` and
AVERROR(EINVAL), exit status 234. `createMediaBackend({numericProfile})` selects
the reference: `darwin-arm64` (the default) or `linux-x64` (the default with the
x86_64 pixel profile). Under `linux-x64` both backends fail such a count before
any input or output is opened, with the native message and status, for `-frames`
with any stream specifier and `-aframes`, `-vframes` and `-dframes`. The CLI
launcher reads `EDGEFFMPEG_NUMERIC_PROFILE`. The frame-limit, apad, rawvideo and
rawvideo timing differential tests select the profile from the pinned reference
and compare the rejection on linux-x64 and the output on darwin-arm64. Native
parses output options after opening its inputs, so a command that also names a
missing input reports the input error natively and this error in Edge.

General stream selection, video/subtitle frame limits, compressed packetization,
filters that alter frame boundaries and explicit packet-sizing controls remain
unimplemented. Passing these cases does not establish general `-frames`
compatibility across arbitrary codecs or graphs.
