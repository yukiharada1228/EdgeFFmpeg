# Zero-packet MP4 streamcopy

Regenerate with `node tools/differential-runner/mp4-zero-copy/generate.mjs`.

126 jobs derive from owned leading-edit inputs:18 single zero-packet inputs and
108 combinations of6 two-track sources,3 empty-track masks and6 map orders.
The generator checks pinned Native artifact and input hashes, then freezes
Native-only streams, packet clocks/flags and encoded payload hashes. Test helpers
verify the generator, source and result manifests. A second full generation
reproduced every JSON artifact byte-for-byte.

Unlike H264 transcoding, streamcopy succeeds when all selected tracks contain no
packets. Nonfragmented MOV omits empty track boxes. Nonempty output keeps planned
track IDs and dispositions. Automatic selection uses packet availability before
default disposition and video area. Payload validation retains original planned
stream indices even when metadata omits an earlier empty track.

Node and local workerd/R2 compare fresh Native results. Worker controls exercise
cancellation, failure on the moov write and insufficient planning budgets.
Container byte identity, general fragmented output, production resource limits
and complete metadata/error compatibility remain outside these tests.
