# Mono/stereo channel remix

`@edge-ffmpeg/swresample` exports `remixAudioFrame(frame, channels, target, options)` for packed u8/s16/s32/flt/dbl data and their planar counterparts with canonical mono/stereo layouts, unchanged sample rate and finite values. Output owns its buffer and retains sample count and PTS. The media backend supports output `-ac 1` and `-ac 2` for these layouts across supported raw PCM/G.711, WAV, AIFF and framecrc paths.

Mono-to-stereo uses a gain of 1/sqrt(2) in each channel. Stereo-to-mono uses 0.5 per channel for integer destinations and 1/sqrt(2) for floating destinations. Internal processing uses dbl for dbl input, s16 for u8/s16 input and u8/s16 destination, and flt otherwise. The s16 path uses Q15 coefficients and half-up rounding; s32 input can therefore lose precision through native-compatible flt processing.

Floating rematrix processing in the CLI requires `-cpuflags 0`. Scalar native builds can still differ because compilers contract multiply/add instructions. `createMediaBackend({ remixArithmetic: 'separate' })` is the default; `'fused'` selects software IEEE nearest-even fused multiply/add. The direct API calls this option `arithmetic`. The Node launcher accepts `EDGEFFMPEG_REMIX_ARITHMETIC=fused`. These are explicit reference arithmetic profiles, not FFmpeg command-line options. Runtime code performs no native probing or fallback. Differential tests select between the two known profiles using an independent reference fixture; they do not alter oracle build flags to obtain a pass. Canonical Linux build equivalence remains unverified.

Remixing runs after the filter chain. With channel conversion, fixed-precision filter negotiation is resolved independently of the destination encoder format, including s32 negotiation for floating input. Stateful FIFO filtering and output timing limits remain upstream of remixing. `resolvedSampleFormat` exposes the compiled chain's resulting packed format.

Unknown source layouts require the existing permitted native layout guess; exotic layouts, channel changes during stream copy, custom matrices, more than two channels, non-finite rematrix inputs and actual sample-rate conversion remain unsupported. Unchanged channel declarations use the existing path. This scope does not implement general swresample or the aresample filter.

The static payload planner reserves six additional buffer slots for remix handoffs and uses the larger input/output channel count. This is conservative accounting, not measurement of total JavaScript/Wasm peak memory.

Evidence includes 50 packed-format/direction comparisons, the complete signed16 mono input domain and stereo boundary pairs, 128 raw codec/direction combinations, 126 filter/timing combinations, WAV/AIFF metadata and decoded output checks, and execution in local workerd. These finite fixtures do not certify every floating value, CPU profile or production deployment.

The differential suite runs one test worker at a time so native reference processes do not compete across large matrices simultaneously. Assertions and per-case timeouts are unchanged.

Library rematrix entry points now accept and emit planar formats through packing-independent precision selection and direct per-channel reads/writes. See [planar rematrix scope](planar-audio.md#planar-monostereo-rematrix) for allocation and validation evidence. General CLI planar filter negotiation remains outstanding.
