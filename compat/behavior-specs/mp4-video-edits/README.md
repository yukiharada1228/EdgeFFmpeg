# MP4 video edit oracle

Reproduce using the pinned local FFmpeg/FFprobe reference:

```sh
node tools/differential-runner/mp4-video-edits/generate.mjs
```

The generator verifies reference binaries and the self-owned H264 MP4 corpus.
It produces71 inputs from a12-picture frozen source and a four-GOP Native remux.
Thirty version0/version1 pairs preserve the same Native packets and frame clocks
(positions change when the wider ELST moves media data). Eight additional cases
use values above2^32; three use media times near INT64_MAX. Box ancestors and
STCO/CO64 positions are relocated when ELST grows. Genuine wide values remain
bigint through construction and are stored as decimal strings when necessary.

Cases cover nonaligned starts, short duration, preroll/postroll, keyframe ranges,
all-discard output and overflow of mediaTime+duration. Pinned MOV treats that
overflow as a zero-length edit. Original media nb_frames remains distinct from
the reconstructed packet count.

Native packet clocks, flags, positions, durations and decoded raw/best-effort
timestamps are frozen in results.json. The manifest binds inputs, results,
reference provenance and generator sources. Expected values never come from
candidate output. Sixty-eight-case Node816/workerd544/copy-R268 functional tests
passed before the final three int64 cases were added. All71 demux, decoder-clock
and actual Node streamcopy comparisons passed; the final expanded functional
batch must be collected separately. Encoded payload hashes are compared after
remux; container byte identity is not claimed.

The copy plan records source timestamps separately from normalized destination
DTS and STTS deltas, so source corruption is still rejected. Rolling presentation
end and the end latched on non-discard packets remain separate. Positive output
starts generate empty output edits following Native movenc behavior.

General multiple/empty input edits, non-unit rates, arbitrary signed-CTTS and
state changes, metadata/errors and production resource conformance remain open.
