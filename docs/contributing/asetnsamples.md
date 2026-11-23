# Stateful packed-audio reframing

The audio chain supports `asetnsamples` (default 1024 samples, padding enabled),
`asetnsamples=512:p=1`, and the `n`/`nb_out_samples` and `p`/`pad` aliases.
Counts are positive decimal int32 values. Padding accepts 0/1/false/true.
Expressions, arbitrary timestamp gaps and midstream format changes are outside
this initial profile and fail explicitly.

`AudioFilterChain.process(frames, options)` runs a bounded sequential streaming
chain. Stateless operators retain their existing frame processing; each
asetnsamples node has its own FIFO for that execution. The standalone
`reframeAudio` primitive is also exported. Calling the single-frame `apply`
method for a reframing chain fails explicitly.

Each yielded frame has independent buffer ownership. The FIFO consumes input
only as needed for the next output and closes upstream iterators on early
return. Timestamps are sample-aligned bigint positions; metadata must remain
stable and subsequent timestamps must be contiguous (or consistently unknown).
At EOF, p=0 emits a short final frame and p=1 fills the final frame with silence:
128 for u8, zero bytes for signed integer and floating formats. Empty input does
not produce an extra padded frame. Pipeline state is isolated between calls,
including concurrent uses of the same compiled chain.

The largest required frame, including format conversions, must fit the CLI's
maxBufferBytes. Oversize requirements fail before output creation. Each FIFO
may coexist with input, output and codec buffers; [Aggregate payload planning](pcm-memory-planning.md) additionally reserves
concurrent buffers and can shrink physical input packets. This remains a static
policy rather than an aggregate resident-memory measurement. No checkpoint serialization or temporal
filter graph scheduler is claimed.

The frontend plans input-only trimming, known sample-count changes and final
packet sizes before output. Reframing chains then apply output seek/duration
and frame-count limits after the filters. WAV/raw muxers receive the predicted
sample count, and framecrc uses the new packet boundaries. This preserves
padding-only tails and native first/last packet trimming. EOF/seek restrictions
from the existing finite PCM profile still apply.

Evidence includes six PCM codecs, five consecutive/mixed chains, ten time/limit
profiles and two I/O budgets. WAV/raw output tests cover default size, aliases,
unsigned silence and duration/sample counts. Unit/workerd tests cover ownership,
backpressure, cancellation, preflight resource limits and aborted staged output.
The original FATE pad and nopad cases both require their complete upstream
framecrc references, using the pinned generated stereo WAV.
