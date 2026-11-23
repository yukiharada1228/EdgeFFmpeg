# AAC-LC multiple edit intervals

Regenerate with `node tools/differential-runner/mp4-audio-intervals/generate.mjs`.
The generator verifies pinned Native binaries and the owned MP4 source manifest
before and after execution. Candidate code is never used for expected values.

288 inputs cover12 AAC-LC sources (mono/stereo, primed/unprimed,8k/44.1k/48k),
short and16copy-loop sources, ELSTv0/v1 and six patterns: contiguous, repeat,
reverse, middle empty, zero duration and long unaligned trim. Box rewrites update
ancestor sizes and affected STCO/CO64 offsets. Probes retain source packet
positions/clocks/flags/skip samples, stream/global start and duration/count.
Copy probes retain stream fields, packet clocks/flags/side data and encoded
payload hashes, without claiming container byte identity.

An independent-directory full Native regeneration reproduced inputs, results,
provenance and manifest byte-for-byte. Helpers verify generator/source/artifact
and individual input hashes, unique IDs and complete case counts.

This is a bounded default-MOV AAC-LC continuation with matching ASC/sample/track
clocks. AAC composition offsets, differing clocks, strict/probing/general error
semantics, compressed decoding and measured production resources remain open.
