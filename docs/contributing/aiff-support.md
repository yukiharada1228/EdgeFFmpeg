# Finite AIFF and AIFC support

`@edge-ffmpeg/containers` exports `openAiff`, `muxAiff`, `supportsAiffCodec`,
`validateAiffOutput` and their types. The CLI accepts `-f aiff`, infers output
from .aif/.aiff/.aifc extensions and defaults to pcm_s16be. AIFF versus AIFC form
type is selected by codec, not filename extension, matching the native muxer.

The nine supported codecs are pcm_s8, pcm_s16be, pcm_s24be, pcm_s32be,
pcm_s16le (sowt), pcm_f32be (fl32), pcm_f64be (fl64), pcm_alaw and pcm_mulaw.
Integer big-endian output uses AIFF; the remaining tags use AIFC with FVER.
Other compressed tags and PCM representations are explicitly rejected.

## Parsing and writing

The reader scans bounded chunk headers and skips unknown payloads by offset.
It validates FORM/chunk bounds, known COMM sample counts, a single SSND chunk,
complete sample frames, optional sound offsets and integer sample rates encoded
as exact 80-bit extended values. Short reads, chunk-count limits and cancellation
are handled without loading the whole audio file. Packet data uses bounded raw
sample reads. AIFC requires the supported FVER value in this profile.

Recognized CHAN named layouts cover the tested native three/four/five/six-channel
cases. Channel bitmaps with matching channel counts are supported; arbitrary
channel descriptions and custom orderings are rejected. The writer emits
canonical bitmaps when an explicit non-mono/stereo mask is supplied. Named-tag
versus bitmap header identity is not promised for multichannel files.

Output uses a known sample count and sequential staged writes. Header sizes,
80-bit rates, COMM/FVER, SSND length and odd-byte padding are calculated before
publication. Count/32-bit FORM overflow is rejected before CLI output creation.
Failure or cancellation aborts the transaction; an abort is not retried after
the raw mux layer has already attempted it. Adapter-specific uncertain commit
recovery remains necessary.

## Frontend semantics

`detectAudioContainer` performs a bounded four-byte magic probe for WAV or AIFF,
so input filenames need no recognized extension. Explicit raw declarations
continue to bypass detection. AIFF default semantic packets contain at most
4096 coded bytes, aligned to complete channel/sample frames. This differs from
the WAV/raw sample-rate-based profile and is passed into seek/duration/frame
limit planning independently of physical I/O size. Stateful filter framing can
replace those boundaries as before.

In-bounds, exact-EOF and beyond-EOF AIFF input seeks are tested. Unlike the
existing WAV/raw EOF fallback profile, AIFF EOF seeks produce empty output in
the verified cases and are allowed. Other existing PCM conversion, filter,
resource-planning and overwrite policies apply.

```sh
npm run ffmpeg -- --root ./media -- -i /source.wav /output.aiff
npm run ffmpeg -- --root ./media -- -cpuflags 0 -i /output.aiff -f s16le /decoded.raw
```

## Evidence and gaps

54 mono/stereo codec/rate cases match complete native -bitexact AIFF/AIFC file
bytes and auto-detected decode output. 108 timing cases cover copy or fixed
volume/reframing/asetrate, seeks including EOF, duration and frame-count limits.
Four native named layouts and emitted bitmaps are compared through native
ffprobe/decoded bytes. Workerd streams AIFC through staged R2 output, probes it
and converts it back with eight-byte I/O budgets.

Unit tests cover sound offsets, malformed/oversized chunks, fractional rates,
blocked data rejection, count mismatch, deterministic header mutations,
cancellation and single-attempt abort cleanup. Fractional rates, blocked/multiple
sound chunks, sound-before-common ordering, arbitrary compression names/tags,
custom channel descriptions/orderings, metadata copying, unknown lengths and
large-file variants remain unimplemented or unverified. Header identity is only
asserted for the named mono/stereo bitexact fixtures; full AIFF compatibility
and production Workers conformance are not certified.
