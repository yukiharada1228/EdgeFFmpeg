# Partial audio filter execution

`@edge-ffmpeg/avfilter` provides `compileAudioFilterChain(description, { outputSampleFormat? })`. It compiles a bounded, single-input/single-output chain of anull, asetrate, asetnsamples and constant volume operators. The compiled object exposes immutable steps, negotiated output precision, maximum intermediate sample width and apply(frame, { maxFrameBytes, signal? }). Stateful reframing chains use process(AsyncIterable<frame>, options). It is not a general FFmpeg graph parser/scheduler.

Supported forms include anull, [asetrate](asetrate.md), volume, volume=0.5, volume=volume=0.5:precision=double and comma-separated combinations. Audio CLI aliases -af, -filter, -filter:a, -filter:a:0 and -filter:0 are accepted for the single audio stream. The last audio-filter option wins. Filtering with -c copy fails before I/O.

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -n -i /input.wav -af 'anull,volume=0.5,anull' -c:a pcm_s16le /quiet.wav
```

## Formats, arithmetic and ownership

anull passes through a validated packed frame without mutation and may return the original frame object. It does not create a second ownership claim for that buffer. Volume creates an independent converted frame and never mutates the caller's input.

Volume accepts finite numeric constants (including scientific notation), negative gains and dB suffixes. Default/float precision negotiates packed flt and uses a float-rounded gain and float-rounded multiplication. Double precision negotiates dbl. Operator order and intermediate precision changes are preserved; signed zero is retained by arithmetic. Rate, channel count/layout, sample count and PTS remain unchanged.

Floating volume output itself is not amplitude-clipped. When encoded into integer PCM, the scalar conversion profile rounds and clips supported finite values. Float-to-integer conversion anywhere in a CLI chain requires -cpuflags 0, including transitions into fixed precision. Integer-only fixed chains need no scalar flag. The supported finite conversion magnitude is at most 32768; outside that bound and for non-finite values, native cast/dispatch profiles remain unimplemented. This extends the earlier normalized-only conversion subset to support ordinary amplification/clipping.

Fixed precision retains packed integer input (u8/s16/s32). Gain is rounded to a
Q8 integer with half-up ties and negative gain is clamped to zero. Samples use
exact bigint products, add-half arithmetic shifts and integer saturation; input
buffers are never mutated. Supported nonnegative gain is at most 65535. Larger
gains currently fail explicitly because native integer overflow/cast profiles
are not reproduced. Float/double precision continues to allow negative gain.

For floating input to fixed precision, the bounded linear-chain negotiation
uses the final integer encoder format when reachable through only fixed/anull
steps, or s32 when another floating step follows or the output is floating.
The frontend supplies the output format hint; direct API use defaults to s32.
`requiresScalarRounding(inputFormat)` detects float-to-integer transitions even
when the final encoder is floating. This is scoped linear-chain negotiation,
not general graph negotiation.

Each buffer must fit maxFrameBytes. The backend sizes input packets for the widest source/filter/target sample representation. Multiple intermediate buffers and R2 part buffers can coexist; these checks are not a total resident-memory measurement. Processing observes cancellation between steps and periodically within sample loops.

## Gaps

The chain is limited to 32 operators and 4096 description characters. Arbitrary expressions, eval=frame, timeline enables, ReplayGain options, commands, escaping/labels, branching, other temporal filters and general format negotiation remain unimplemented and fail explicitly. Non-finite volume input is also explicitly unsupported, including unity gain cases native FFmpeg may optimize as pass-through. Later failure aborts staged WAV output.

dB gain calculation uses JavaScript's numeric exponentiation. Its reference contract is numerical (absolute/relative bound 1e-12 times max(1, abs(reference))), not a promise of identical libm results on every platform. Linear fixture contracts compare exact PCM bytes under scalar native dispatch. Passing those fixtures does not certify every gain, value, architecture or graph.

## Evidence

Native tests cover six source codecs, six target codecs and eight linear/pass-through/ordered-precision chains (288 combinations), comparing CLI-generated WAV PCM to the pinned FFmpeg with -cpuflags 0. An additional 504-case matrix covers fixed and mixed precision chains. Full u8/s16 value domains and s32 boundaries are compared for four gains under default/scalar native dispatch, and workerd checks bigint fixed arithmetic. Separate dB tests compare four gains and both precisions numerically. Tests include clipping, negative gains and signed zero. Node integration covers aliases, last-option precedence, copy/filter rejection, required scalar policy and abort after a later non-finite packet. workerd executes a chain and persists its result through staged R2 output.

Behavioral syntax reference: pinned upstream doc/filters.texi, volume section. No FFmpeg filter source was translated into this implementation.

See [asetnsamples](asetnsamples.md) for bounded FIFO processing, padding ownership, post-filter time selection and native FATE evidence.
