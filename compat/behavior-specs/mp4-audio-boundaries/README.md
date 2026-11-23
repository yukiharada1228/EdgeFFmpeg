# AAC-LC signed64 edit search boundaries

Regenerate with `node tools/differential-runner/mp4-audio-boundaries/generate.mjs`.
The Native-only generator validates pinned ffmpeg/ffprobe identities and owned
source manifests before/after generation.192 inputs use all12 AAC-LC sources:
mono/stereo,primed/unprimed,8k/44.1k/48k,short/16copy-loop,ELSTv1 and eight media
time positions:INT64_MIN,+1,+timescale-1,+timescale,+timescale+1,INT64_MAX,
INT64_MAX-timescale+1 and negative-two control.

Pinned MOV search subtracts one second in signed64 before clamping to the first
source DTS. Wrapping at the lower boundary therefore selects the final source
packet, whereas unbounded integer subtraction selects the first. This affects
packet identity and skip samples even when both copy commands succeed.

Fixed probes preserve stream/global start,duration,count/rate/channels,
source clocks/positions/flags/skip side data and copy stream/packet metadata
plus encoded payload hashes. Container bytes, general malformed-input error
semantics, compressed decoding and production resource conformance are not
certified. Individual inputs and generator/source/artifact hashes are verified
by the helper. Independent regeneration and canonical tests are recorded in
candidate evidence before promotion.
