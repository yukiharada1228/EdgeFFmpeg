# MP4 demux foundation

Implements bounded asynchronous metadata/index reads
and lazy packet iteration through ReadHandle. No native runtime dependency.

Current support: local non-fragmented video and version-0 audio sample entries;
stts/ctts, stsz/stz2, stco/co64, stsc, stss, 32/64-bit headers and times;
one full-duration unit-rate edit, plus AAC-LC priming ending at the media end
with a sample-aligned start. Skip Samples and final discard padding are exposed. Audio sampleRate is taken from the sample
entry; containerChannels is the container field, not decoded codec channel
configuration. codecChannels is exposed for parsed AAC-LC configuration, and
defaultDisposition reflects the enabled track flag. Video width/height are zero for audio tracks. sampleEntry owns
its bytes and preserves codec configuration for future decoder integration.

Resource options are required positive safe integers (at most INT32_MAX).
maxBoxes is global across top-level boxes, nested metadata and data references;
maxIndexBytes charges33 bytes per indexed sample. Payloads stay in the VFS until
requested. This accounting is not yet an authoritative peak-memory measurement.

Current evidence: 85 pinned Native fixtures compared through Node and R2 in
Miniflare:24 video encodes,16 table/header rewrites,2 negativeCTTS,15 wide-time,
12 AAC audio encodes with/without priming edit lists,8 multitrack layouts,8 reordered two-video timing fixtures. Packet payloads, metadata and native interleaved stream/position order compared.
interleavedPacketHeaders() exposes owned metadata without payload reads.
interleavedPackets() keeps independent cursors and reads one selected packet
at a time, using pinned MOV selection rules (microsecond rounding, one-second
DTS threshold and file-position preference for nearby samples). Threshold
cases stretch timing1/25/26/100x and group physical packets in both track
orders; Native backward file jumps distinguish clock preference from a
position-only implementation. Source/reference/fixture hashes are recorded in
compat/behavior-specs/mp4-demux/manifest.json.
Safety tests include a sparse virtual co64 position9007199254740993 (above
number safe-integer range), R2 replacement/same-content generation/deletion
faults and cleanup, budget boundaries, external/encrypted entries, out-of-mdat
sample positions, broken readers and cancellation before/after IO.

Unfinished: fragmented MP4, general edit lists (including non-aligned AAC trimming),
versioned audio entries, multiple sample descriptions, subtitles, encryption,
general codec parameter parsing, decoders and seek integration. Scoped
[muxing and CLI packet copy](mp4-mux.md) now use the indexed metadata.
These unsupported paths reject explicitly. Miniflare is not production Workers
certification. See the container package NOTICE-MP4/NOTICE-MP4-MUX and COPYING.LGPLv2.1
for source provenance.

Regenerate reference metadata with `node tools/differential-runner/mp4-demux-reference.mjs`.
This uses the pinned local `.build/reference` binaries; normal regression tests
use embedded fixtures and recorded Native results.

MDHD language metadata is now exposed and preserved through scoped muxing; raw
track IDs include zero and high unsigned32-bit values. CLI matching follows the
pinned signed-ID convention. See [selection scope](mp4-selection.md).

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

### Default video edit rate words

Pinned default advanced MOV reads the rate word but does not apply it during
index reconstruction. The video path accepts all uint32 words after validating
box bounds and preserves the same timeline.96 frozen/fresh Native Node/R2 copy
comparisons cover v0/v1, contiguous/mixed-zero lists and8 rate words. This is
reference behavior rather than a playback-speed conversion; general strict
options and other edit semantics remain incomplete.

### Isolated negative video media-time continuation

Default advanced MOV accepts negative media times below-1; strict validation
is a separate option.66 Native-only fixtures cover v0/v1 and32/64-bit bounds,
including INT64_MIN. Duration overflow matches unsigned64 addition. The input
search position can equal INT64_MIN while reconstructed output timestamps keep
their existing signed bounds and nullable-sentinel policy. Raw/default packet
probes and66 Node/R2 copies match.792 Node/528 R2 H264 comparisons,3rollback
controls and previous positive edit/rate regressions passed. The four JSON
artifacts reproduce in an independent generator directory. General strict,
probing, metadata/error and production resource conformance remain open.
This continuation is excluded from Root's running v29 full report.

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
