# H264 MP4 framecrc integration

The injected independent ABI2 decoder now feeds rawvideo framecrc output with
explicit passthrough timing. Native FFmpeg remains a development oracle. The
output contains encoder timebase, dimensions, sample aspect ratio, DTS/PTS,
duration, frame bytes and Adler checksum. Output `-bitexact` suppresses the
software label; other output retains the EdgeFFmpeg software label.

The index-only probe retains STTS average rate, constant-duration Native MOV
rules and bounded standard-rate error accumulation. The fixed399-rate table
uses default20/40 duration observations and a5second analysis bound. Native
av_guess_frame_rate selection also uses the active SPS nominal rate. A concrete
counterexample has average200/9 versus Native guessed89/4; the default output
must use4/89, while demux/filter clocks remain1/20000. Existing encoder-PTS
rounding and mux duration inference are reused. The packet-index probe budget
and16896bytes of rate/header payload are reserved before decoding.

The active decoder parameters snapshot is immutable and cleared on close.
Per-picture SAR stays associated with the pending timestamp token. MP4 pasp
wins over SPS aspect. Scale composes bounded aspect ratios and transpose
inverts known nonzero aspect. Empty output initializes metadata without
materializing transformed pixel frames. Pixel checksums borrow the existing
owned tight frame allocation; writes remain bounded and transactional.

Validation:324base NodeCLI comparisons,15derived-clock comparisons,20aspect
comparisons,27source-track FFprobe comparisons,53workerd/R2 comparisons and
two rollback controls. Derived inputs use the pinned Native setts BSF on
self-owned MP4 data. Aspect inputs use Native streamcopy with an explicit DAR.
The first missing-pasp header difference and the average-vs-guessed-rate
counterexample are retained in ignored development evidence.

These tests do not certify general H264,all MOV edits,automatic/CFR modes,
full probe termination across multiple streams,parameter-change rate inference,
all input-start/TKHD/metadata/error semantics,or production isolate memory.
The implementation states remain partial. Full FFmpeg compatibility is unproven.
