# MP4 packet copy and finite muxing

`openMp4`, `planMp4Copy` and `muxMp4` form a bounded packet-copy path.
`interleavedPacketHeaders()` and copy planning use indexes without reading payloads.
The muxer snapshots sample metadata, consumes one packet at a time, validates it
against the finite plan, writes bounded chunks, then commits or aborts. Metadata
budgets are estimates for these operations, not measured total runtime heap/CPU.

The mux supports nonempty copied video/version0 audio sample descriptions, co64, STTS,
nonnegative composition offsets, sync samples, scoped origin edits and AAC-LC
priming/padding. Version1 mvhd/tkhd/mdhd/elst switches at pinned INT32_MAX duration
boundaries. Movie timescale follows the common track-clock denominator with Native
minimum1000. Unsupported clocks, noncontiguous plans, arbitrary discard flags and
packet durations requiring unimplemented Native DTS correction reject explicitly.

`createMediaBackend()` supports one-input/one-output MP4 copy commands:

```ts
await ffmpeg.exec(['-i','/source.bin','-map','0','-c','copy','-f','mp4','/result.mp4']);
```

`-f mp4` or `.mp4` selects output; declared MP4/MOV/m4a input also routes to this
path. Input content is parsed regardless of filename. Explicit non-MP4 output
formats win over filename hints. General probing without these hints and IPOD/m4a
output defaults remain unfinished.

Automatic video/audio selection follows pinned packet presence, default flag and
geometry/codec-channel scores. Type/index/ID/language maps, optional and negative maps, ordered or
repeated maps, `-an`/`-vn`, codec stream specifiers and last matching copy options
are supported. Unmatched optional maps fall back to automatic selection. AAC-LC
codec channels are distinguished from the container channel field. Each selected
stream must resolve to `copy`; this path does not encode or decode compressed media.

Output groups retain confirmed/uncertain publication effects. R2 lost acknowledgment
and cleanup failures can be reconciled using transaction markers. An empty output
list on failure does not prove rollback. No Native FFmpeg or external transcoding
fallback runs in the library.

## Evidence and remaining work

197 Node CLI and204 local workerd/R2 CLI jobs compare fresh pinned Native packet
bytes/clocks/flags/Skip Samples and selected codec/stream/disposition fields.
92 container API copies include seven duration-boundary cases.85 original files
have identical decoded Native framecrc after rewriting. Container bytes are not
claimed bitexact. Fixtures, reference source and binaries are hash-pinned.

Tests include slow sinks, cancellation after in-flight writes, source replacement,
packet-plan mismatch, budget rejection, actual Node filesystem transactions,
overwrite protection and R2 publication uncertainty/recovery.

General edits, signed mux composition offsets, general selector syntax, time selection,
multiple inputs/outputs, fragments, subtitles, encryption, complete metadata,
compressed encoding/decoding, protocols, large multipart/heap/CPU evaluation and
production Workers certification remain incomplete. Both demuxer.mov and muxer.mp4
are partial, with no full conformance or binary compatibility claim.

See [input selection and language](mp4-selection.md) for signed IDs, disabled-map
ordering and pinned metadata-token behavior.

### Zero-packet selected streams

Nonfragmented copy keeps a selected zero-packet stream in its execution plan,
but omits its `trak` box from the output, matching pinned MOV trailer behavior.
When every selected stream is empty, copy succeeds with zero output streams.
H264 transcoding of the same input still fails because no decoded format exists.
Automatic video selection scores available indexed packets before disposition
and resolution. Original STSZ sample count does not imply readable packets.

Metadata omission does not renumber planned packet identities: later-stream
packets must still match their original selected stream index. A unit control
rejects an incorrectly renumbered packet and verifies abort without commit.
The fixed `mp4-zero-copy` corpus covers126 Native jobs, including mixed empty
tracks, reverse/duplicate mappings, IDs, dispositions, timestamps and payloads.
Node and local workerd/R2 run fresh Native comparisons; Worker tests also cover
cancellation, metadata-write failure and insufficient planning budgets.
These results do not establish container byte identity or production limits.

### Multiple video edit intervals

The scoped default MOV path reconstructs2/3/4/8 unit-rate intervals, including
reversed/repeated media positions, leading/intervening empty entries and zero
durations. Original STSZ sample count differs from the expanded packet count.
Packet order remains stable within each selected stream despite backwards DTS.
The60-case Native-only fixture has separate nofillin/default packet expectations
and streamcopy outputs; payload identity does not imply container byte identity.

Entry metadata, temporary clock/flag copies and final index arrays are bounded
before allocation. Non-CTTS timing-table exhaustion exposes zero duration in
the raw container API. Bounded progressive H264 probing fills default duration
and repairs DTS from a PTS window while respecting active SPS reorder depth.
Decoding retains missing DTS; copying substitutes PTS before strict mux repair.
MOV initial reorder estimation requires CTTS. General rates, unrestricted SPS
delay inference, probing termination and production resource conformance remain
open. Node720/R2480 decoded comparisons,60 Node/R2 copies and2716 previous H264
comparisons passed; all claims remain scoped and partial.

### Isolated AAC-LC edit/copy continuation

AAC-LC mono/stereo paths now cover leading v0/v1 delays and fractional priming
within the first second. Partial priming packets keep their key flag while
whole preroll packets retain discard flags. Nominal codec rate/frame length
comes from ASC. Source final discard padding is clipped against the Native
stream duration; mux presentation/end-edit separately uses max(codec-frame
duration,packet duration)-discard padding without changing planned STTS.

Copy plans deep-copy source skip-sample stamps; changed stamps abort staging
and preserve previous output. Low-level samples without source-plan stamps
retain their earlier validation.69 owned Native input probes and114 fresh
Native/Node and114 Native/workerd-R2 copies cover default/ordered/duplicate
audio mapping and original-file start normalization. Five fixed JSON artifacts
reproduce in an independent generator directory. General multiple AAC media
intervals,long-range unaligned trims,metadata/errors and measured production
resources remain unfinished. This work is excluded from Root's running v29.
