# Audio rate reinterpretation

The packed single-audio-stream chain supports `asetrate`, `asetrate=20000`,
`asetrate=r=20000` and `asetrate=sample_rate=20000`. The default is 44100 Hz.
The current parser accepts positive decimal integers through signed-int32 max;
rate expressions, fractional constants and suffixes remain unimplemented.

This filter changes the interpretation of existing samples. It does not
resample, interpolate, add or remove samples. Playback speed, pitch and duration
therefore change. The frame sample rate and sample-aligned PTS time base change;
PCM planes retain their original ownership and bytes. Multiple asetrate nodes
preserve sample positions, including bigint positions beyond number precision.
Unaligned/invalid timestamp time bases fail explicitly in the direct frame API.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af asetrate=20000 -frames:a 20 /retimed.wav
```

`AudioFilterChain.outputSampleRate(inputRate)` exposes the final rate for the
planner. The backend keeps input seek/duration in the input rate and applies
output seek/duration in the final filter rate. Packet-count limits retain the
input demuxer's semantic packet boundaries. WAV headers and framecrc headers
use the final rate. Output `-ar` is accepted when it equals that final rate;
requesting another rate still requires unimplemented resampling and is rejected
before output creation. Filtering with copy remains unsupported.

Evidence includes 72 native framecrc scenarios and two I/O budgets covering
input/output time selection, duration/end time, frame limits and mixed
fixed/double volume chains at two input and two final rates. WAV tests compare
rate metadata, sample count and unchanged PCM data. Workerd verifies output
seek and a packet-count limit after rate reinterpretation with eight-byte reads.

The original `fate-filter-asetrate` target also runs through upstream Make and
the native framecrc helper. Its generated WAV is SHA-256 pinned. The adapted
Edge command must match the complete upstream expected framecrc text, including
all 20 packet timestamps, durations, sizes and checksums. This is separate from
general resampling, filter graph and FATE compatibility.
