# AAC-LC explicit24-bit frequencies

Regenerate with `node tools/differential-runner/mp4-aac-explicit/generate.mjs`.
384 inputs replace each owned table frequency by its equivalent explicit24-bit
value:12 original AAC sources,60 leading edits,288 multiple intervals,12 Native
faststart sources and12 large-offset v1 sources with one extra movie tick.
The wide sources deliberately contain odd timestamps beyond2^53; integer
precision is retained throughout the Native oracle and Core comparison.

Rewrites update nested descriptor sizes,ancestor boxes and affected STCO/CO64
offsets. Frequency/channel/frame bits and remaining ASC data stay in position.
Native ffmpeg copy commands succeed; the pinned ffprobe AAC decoder rejects
explicit frequencies during unconditional decoder open. The fixed-libavformat
API oracle is calibrated against ffprobe on1533 ordinary AAC inputs before
fixture generation. Its compiler/source/library/binary hashes and full parity
receipt are recorded. It emits64-bit integers as strings and packet payload SHA.
This establishes container/streamcopy behavior,not AAC decoding compatibility.

Fixed source probes include clocks,positions,flags,size,skip/padding,raw payload
hashes and stream/global metadata. Copy probes retain source ASC extradata,
stream/packet fields and payload hashes without container byte identity. Node
and local workerd/R2 compare actual output against fresh/frozen Native output;
transactional failure controls remain required. Helpers verify unique IDs and
all generator/provider/source/artifact/input hashes. Zero explicit frequency,
other object types/PCE/SBR,strict/probing/general error semantics and production
resource measurements remain open.
