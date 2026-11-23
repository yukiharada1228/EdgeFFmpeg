# Partial PCM WAV time selection

The finite WAV/raw PCM backend now accepts input- and output-scoped `-ss`, `-t` and `-to`. Option order determines file scope, and the last value of each option in a scope wins. A supplied -t takes precedence over -to, as in the pinned reference. An active -to must be greater than that scope's -ss. Invalid time syntax, negative time options and inconsistent bounds fail explicitly.

`parseTimeDuration` in the CLI package converts ordinary decimal/clock durations and s/ms/us suffixes into bigint microseconds. Additional fractional precision is truncated; arithmetic never passes through a JavaScript number. Signed decimal values can be parsed by the helper, but negative backend time selection remains unimplemented. Duration strings are length-limited and bounded to signed 64-bit microseconds. Not every native parser quirk is reproduced; exact diagnostic text/exit codes are not certified.

```sh
# Seek input, then encode a 1.5-second PCM region.
npm run ffmpeg -- --root ./media -- -ss 0.25 -i /input.wav -t 1.5 -c:a pcm_s16le /clip.wav

# Select an output interval. Copy uses native default WAV packet boundaries.
npm run ffmpeg -- --root ./media -- -i /input.wav -ss 0.25 -to 1.75 -c copy /copy.wav
```

## Boundary semantics

Input PCM seeks round to a sample position. Decoded output seeks round independently. The selected region is rebased to sample zero and read directly by range, without decoding unrelated earlier PCM. Duration and output WAV byte lengths are known before opening the output transaction.

Copy selection follows the pinned WAV PCM demuxer's default packet span: a power-of-two sample count corresponding to the observed native default profile. Input seeking resets its origin. Output copy seeks and time limits select complete native packet intervals, independently of EdgeFFmpeg's configured read buffer size. Physical reads still obey that buffer size and do not allocate a native-sized packet when it would be larger.

The reference also has nonobvious sub-sample behavior. For encoding, a decoded input duration that rounds to zero samples disables that trim limit, including input -t 0. An output -t 0 yields empty output. A positive output duration that rounds to zero samples permits the first remaining native decoded frame. These cases are explicitly tested rather than replaced by intuitive interval arithmetic.

Ordinary in-bounds input seeks, output seeks (including beyond EOF), -t/-to combinations, repeated values, units/clock syntax and zero/sub-sample limits are compared to native PCM bytes at 10, 8000 and 44100 Hz, for copy and explicit PCM encoding. workerd verifies the differing copy/encode bounds through persistent R2 output.

## Known gap: input seeking at or beyond EOF

The native oracle can return a buffered tail packet or no data after an input seek beyond EOF, depending on AVIO buffer/seek state. A short 44100 Hz file exposed this difference in differential testing. This fallback is not yet modeled. EdgeFFmpeg currently returns unsupported-seek before output creation for input seeks at or beyond EOF, rather than claiming a matching empty result. A separate diagnostic records native output and tests the explicit rejection. This remains a compatibility gap toward the full target, not a permanent exclusion.

Raw PCM timing is separately compared at 10/8000 Hz, with explicit input declarations. Other gaps include negative seeking/pre-roll, -sseof/-copyts/-start_at_zero, altered native packet-size options, compressed codecs with delay/keyframes, filters with temporal state and exact native logs/errors. Time selection is not a general seek planner or a checkpoint mechanism.

Reference syntax is derived from the pinned upstream `doc/utils.texi` time-duration specification; boundary rules were established by executing the pinned reference, without translating its source.
