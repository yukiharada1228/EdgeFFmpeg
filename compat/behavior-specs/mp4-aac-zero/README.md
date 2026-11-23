# AAC-LC zero explicit frequency and MOV fallback

Regenerate with `node tools/differential-runner/mp4-aac-zero/generate.mjs`.
The Native-only generator verifies pinned binaries and the explicit-frequency
source manifest; the calibrated Native libavformat probe is reused.60 inputs
use12owned sources and nominal/half/double/1000/one MDHD clocks. ASC frequency
bits are zeroed while channel/frame bits and encoded payload are retained.

Pinned mov_finalize_stsd_codec fills an unset codec sample rate from MDHD when
its timescale is greater than1.48inputs therefore demux/copy successfully.
The12scale1inputs retain unresolved sample_rate0 in demux metadata and fail
streamcopy. All60 raw packet/stream probes remain in the corpus; failing copies
are not filtered. Positive Node/R2 outputs compare fixed/fresh Native metadata,
ASC bytes,packet clocks/skip data and payload hashes. Negative cases verify
failure existence,Node prior-output sentinel preservation and no R2 publication.
Three R2 cancellation/write/planning-budget controls are also required.

Exact error protocol remains incompatible:recorded Native exit234 versus Core
failure1. Tests allow either known generic failure or a future Native-matching
code without accepting process crashes/timeouts. The known difference is
recorded in compat/known-differences/mp4-aac-zero-unresolved-exit.json. Container
byte identity,codec decoding,general probing/errors and measured production
resources are not certified. All source/generator/artifact/input hashes and
positive/negative case counts are checked by the helper.
