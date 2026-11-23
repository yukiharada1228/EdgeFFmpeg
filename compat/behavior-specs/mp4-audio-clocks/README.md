# AAC-LC independent container and sample clocks

Regenerate with `node tools/differential-runner/mp4-audio-clocks/generate.mjs`.
The Native-only generator validates pinned binaries and every owned source
manifest artifact before/after execution.864 inputs cover all12 AAC-LC sources
(mono/stereo,primed/unprimed,8k/44.1k/48k),short/16copy-loop,ELSTv0/v1 and
contiguous/repeated/long-trim edits. Each input uses doubled,halved or1000Hz
MDHD clocks, both with original timing words and with MDHD duration,STTS deltas
and ELST media times rescaled. Movie edit durations retain their own clock.
An independent-directory full regeneration reproduced all4 JSON files exactly.

Source probes preserve stream/global start,timebase,duration/count/rate/channels,
packet identity/clocks/flags and skip/discard samples. Copy probes retain stream
fields,packet clocks/flags/side data and encoded payload hashes. Node and local
workerd/R2 compare actual outputs with fresh Native and fixed expectations;
container byte identity is not claimed.

Default Native MOV uses positive STTS sum to limit declared track duration.
Skip counts accumulated by MOV are retained in their Native representation,
while final discard padding is computed in audio sample units. Zero-duration
packet filling floors codec-frame duration into the track clock. Audio copy
uses Native sample-clock continuity via av_rescale_delta, then strict monotonic
mux clocks. Movie timescale uses pre-conversion stream clocks; AAC output track
clocks use the ASC sample rate. Original source timestamps,duration,timebase
and skip side data remain validated during payload iteration, with rollback
when source duration changes even if output rounding would hide the change.

This does not certify AAC compressed decoding, arbitrary ASC/sample-entry rate
disagreement, composition offsets, strict/probing/general error semantics or
production resource measurements. These remain tracked open capabilities.
