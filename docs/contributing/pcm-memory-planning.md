# Sequential PCM payload memory planning

`@edge-ffmpeg/avformat` exports `planPcmMemory(request)`. The single-stream
backend calls it after format/timing resolution and before opening output.
The plan reserves space for simultaneously live PCM payloads, rather than
checking only whether each allocation fits maxBufferBytes.

The conservative model includes three source-read/assembly/packet slots,
two decoded-frame handoff slots, two slots per volume or FIFO node, one encoder
conversion slot and two encoded-output slots. The widest negotiated sample
representation and largest FIFO frame are used across these slots. Metadata
operators share planes and add no payload slot. WAV metadata/mux scratch and
framecrc encoding scratch have explicit allowances. This can overestimate the
actual live payload of a particular chain.

The planner chooses the largest sample-aligned physical input packet that fits
both buffer and aggregate reservation thresholds. If needed, it reduces the
read size without changing native semantic packet boundaries or frame counts.
If fixed FIFO work plus a minimum packet cannot fit, the backend returns
resource-budget before reading PCM data or creating output. Format header reads
can precede this check. Empty-output requests reserve no PCM payload planes.

The pure API returns frozen component counts, chosen packet samples, planned
payload bytes and limitations. Size calculations use bigint before conversion
back to safe integer byte counts. Known input counts cap the read packet size;
planning never scales allocations to the whole media file.

This is static scheduling policy, not a heap/GC/isolate memory measurement or
hard resident-memory guarantee. It excludes JavaScript objects, dead buffers
awaiting GC, Wasm allocations and VFS/adaptor retention (notably R2 multipart
buffers). Those need separate reservations and runtime observation. A collecting
output sink or a caller retaining frames can exceed this model. The policy can
reject a feasible operation because estimates deliberately overreserve.

Tests verify adaptive packet sizing, multiple FIFOs whose individual frames fit
but combined reservation does not, zero-input reservations and safe arithmetic
beyond number precision. Frontend/workerd tests verify early rejection without
output or data I/O. A native comparison preserves complete framecrc text while
shrinking physical reads from 64 to 24 bytes for a fixed-volume/reframe/rate chain.
These checks do not certify real peak memory or production Workers limits.
