# Multiple MP4 video edits

Regenerate using `node tools/differential-runner/mp4-multiple-edits/generate.mjs`.
The generator verifies pinned reference binaries and owned source hashes before
and after execution. Sixty cases combine three H264 sources, version0/version1
ELST and ten patterns with2/3/4/8 entries: contiguous, skipped, reversed,
repeated, trailing/middle empty, leading plus middle, and zero-duration edits.
ELST replacement updates ancestor lengths and STCO/CO64 positions.

Results contain Native probes with `+nofillin`, default Native packets, and
Native streamcopy outputs. Copy comparison includes IDs, dispositions, packet
clocks/flags and payload hashes. Container bytes are not compared. Test helpers
verify source, generator, artifact and input hashes. Two complete generations
reproduced every JSON artifact byte-for-byte.

Repeated intervals can duplicate a payload position and move DTS backwards.
The execution plan preserves per-stream packet order. Expanded index count,
interval metadata, temporary clock copies and final arrays have separate bounds.
Original STSZ sample count remains distinct from exposed packet count.

Native packet finalization can expose duration0 after timing-table exhaustion;
default packet processing fills progressive H264 duration from active timing.
DTS order checks can temporarily unset DTS, then recover it from a PTS window.
The active SPS can change reorder delay after the first packet. The same packet
repair is used for copy and decoding, while only copy substitutes PTS for
remaining missing DTS. MOV's initial delay estimator runs only when CTTS exists.

Non-unit rates, unrestricted SPS delay inference, broader malformed/overflow
semantics, full probing termination and measured production resources remain
open. These scoped tests do not certify complete FFmpeg compatibility.
