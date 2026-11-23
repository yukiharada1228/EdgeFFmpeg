# Development status

The detailed design is the target, not a list of implemented features.

## Latest complete validation: v35 passed

The full local run finished on 2026-11-22 at 17:58:38 UTC. All 1,242 tests
passed with zero failures or skips: 565 unit, 84 integration, 358 differential
and 235 Workers tests. All 624 scoped comparison contracts, 14 required gates
and five reviewed FATE profiles passed. Raw suite results, log hashes,
source/reference snapshots, contract matching and FATE provenance were audited
against the terminal report. The tested source SHA is
`a82b92caff2865e3b0680ee97415998b46b483b21484a42cc9c06c478267daf5`;
report SHA is `1f363d4ebfe5caefef17d7bab105f74323ecc1903c223a4e080198ef42ebbeb0`.
Later FLAC parser implementation changes are outside that frozen snapshot; a fresh
combined validation is pending.

v33 and v34 remain failed historical runs. v35 includes the bounded Native
matrix execution, all thirteen default channel layouts and the small R2 output
staging allocation; no original comparison matrix or explicit deadline was
removed or relaxed. Passing development validation does not certify complete
compatibility: 2,334 capability entries remain unimplemented and 165 partial,
with zero conformant/bitexact certifications. Canonical Linux, production
Cloudflare, aggregate resource and project-wide license verification remain open.

A separate private FLAC demux prototype passed actual local workerd testing
without Node compatibility: 699 case checks (678 accepted and 21 expected
picture-metadata rejections), 1,815 encoded-audio packet byte comparisons,
66 attached-image byte comparisons, 405 tag maps, 126 chapter comparisons and
seven controls. Audio evidence includes 1,299 comparisons with full-input
Native packet oracles and 516 using Native packets of identical encoded audio.
Picture-corpus packet timestamps were not probed. The earlier baseline also
retains its 273 executions and 1,005 byte/PTS/DTS/duration comparisons.

A separate workerd streaming fixture also verifies the legacy 24-bit picture
size workaround with a 16MiB continuation. Default and explode modes each
produce 16,777,274 image bytes with the exact Native SHA256, preserving the
audio packets and offset. Core-owned buffers peak at 64KiB and return to zero
on completion or consumer cancellation; strict+explode fails as expected.
The generated VFS input matches the Native file hash. Six additional cases
also pass through the public R2 adapter with an actual local Miniflare R2
binding: matching large outputs, strict+explode rejection, consumer cancellation,
changed content and same-content generation replacement. Both replacement
controls reject stale reads, and the test object is removed afterward. Host
fixture setup buffers the upload outside the processing Worker. Production R2
remains unverified.

A later private parser-intake path reproduces FIFO growth, the ten-header
threshold, draining and signed parser offsets. Node VFS tests match 1,209 packet
payloads and 52,068 parser calls across 86 finite clean/malformed conditions.
Actual workerd/local R2 tests pass 22 intake cases and seven metadata-pipeline
cases, including cancellation, input replacement and same-content generation
changes. For the pinned large truncated-picture input, strict without explode
now matches Native's zero pictures and zero audio packets; the other three
policies retain their expected outputs or rejection. This verifies that input,
not general strict-policy or full AVIO/probe scheduling equivalence. Core-owned
buffers peak at 65,570 bytes for the intake/payload fixture and 64KiB for the
metadata/picture pipeline, with all owned buffers released afterward.

Selected prototype components have since been promoted to public FLAC APIs,
as described below. A FLAC registry/CLI route remains unimplemented. Image
pixel decoding, complete malformed-input policy/diagnostics and general codec
compatibility remain open. Fixture transport, returned strings/objects,
provider, response and R2-service buffers are outside Core owned accounting; no
aggregate Worker peak-memory claim follows.

## Public FLAC parser integration after v35

The public avcodec package now exports `parseFlacHeaderCandidate`,
`createFlacDescriptorParser` and `updateFlacCrc16`. The containers package exports
`openFlacPacketRanges`, `readFlacPacketChunks`, `readFlacMetadata` and
`openFlacDemux`. These compose bounded frame parsing, metadata, encoded pictures
and sample timestamp fill-in. They do not register a FLAC decoder or CLI route.
General metadata, AVIO, timestamp and malformed-input behavior remain partial. The metadata foundation reads STREAMINFO and immutable block
descriptors, with a trusted extension callback for later payload handlers.
Unhandled picture blocks stop directory traversal and leave effective/audio
offsets unknown; comments, seek tables and cue sheets remain unvalidated unless
a trusted handler explicitly validates them.

Fresh pinned Native generation matched 86 cases, 1,209 packets and 52,068 parser
calls. The initial public integration passed 15 scoped tests, including actual
local R2/workerd cases, plus typecheck, declarations, lint and boundaries.
These results precede subsequent descriptor-validation and cancellation fixes;
validation of those changes is recorded separately. Three scoped comparison
contracts were added. The full v35 result above remains historical.

A locally installed dynamic workflow now uses the installed Codex CLI rather
than the SDK-bundled executable. Its first review completed seven real agent
calls without failure. Independent verification confirmed checkpoint cancellation
and caller-supplied descriptor validation gaps; a reported scoring-order
mismatch was rejected. Implementation work is divided by owned files, with
review and validation after each batch. Descriptor and cancellation fixes passed
56 scoped tests, including the existing Native parser corpus and actual local
R2/workerd test; typecheck, declarations, lint and boundaries passed. The
metadata foundation now passes 48 unit tests. Combined FLAC validation passes
106 tests in eight files, including the parser corpus, 18 clean Native metadata
inputs over 54 Node short-read comparisons and 36 actual local R2/workerd
comparisons plus two metadata cancellation controls. All owned scratch bytes
return to zero; provider buffers and runtime overhead remain outside this count.
Final typecheck, declarations, lint and boundaries pass. A continuation-budget
regression found during review is covered by an added boundary test. These
checks do not establish general malformed metadata or picture-payload parity.
Full combined project validation has not yet been rerun. Workflow completion is not media compatibility
certification.

## Four-way FLAC implementation wave

A dynamic workflow ran four writers in parallel for comments, chapters,
channel masks and pictures, followed by independent reviews and dependent
public demux integration. A second two-writer repair stage addressed mutable
caller policy, effective pending-packet limits and internal Base64 buffers.
The wave used 11 real agent calls with no backend failures. Passing execution
status is separate from review approval and media compatibility evidence.

The public demux now composes ordered tag dictionaries, comment chapters,
provisional layouts and ordered encoded attached pictures. It uses the actual
parser schedule for strict-picture behavior, preserves advertised versus
effective metadata ends and requires explicit close. Base64 pictures decode
synchronously into Core-owned scratch; external provider buffers remain
separately identified. A total continuation-budget regression rejects before
reading an over-budget image span.

Final scoped validation passed 196 tests in 17 files, with no failures or skips.
All four type configurations, declarations, lint and package boundaries pass.
Node comparisons include eight clean inputs under three short-read schedules
and 47 metadata conditions. Actual local R2/workerd comparisons cover 132
finite Native picture/comment/chapter/mask cases. A compact 16MiB picture
continuation fixture additionally matches four Native policies, including
image/audio hashes, audio PTS/DTS/duration and physical source offsets, plus
consumer cancellation. Maximum Core-owned buffers are bounded at 65,570 bytes
in that fixture and return to zero. Host upload, provider/response buffers,
strings/objects and runtime overhead are excluded; no aggregate heap or
production deployment claim follows.

Full-project validation has not yet been rerun after these changes; v35 remains
historical. New scoped contracts bring the comparison catalog to 633 entries,
without changing capability certifications. SEEKTABLE/CUESHEET, general AVIO,
seek/wrap/nofillin/igndts, decoder/encoder, muxing and CLI integration remain
separate work. These finite comparisons do not certify full FLAC compatibility.

## Current foundation

- npm workspaces, strict TypeScript, Vitest and baseline GitHub Actions.
- Official FFmpeg mirror submodule pinned to the peeled n9.0.2 commit.
- Reference lock, explicit configure flags and source-integrity checked build command.
- Capability extraction records original listings, platform, compiler and binary hashes. The local manifest has 2,499 entries, with 165 marked partial across finite audio/rawvideo, pixel/sample formats and selected audio/video filters. No full conformance is certified.
- Native timestamp differential test: three frame rates, eight frame timestamps each.
- FATE inventory: 2,227 explicit CMD definitions tracked; five reviewed cases (PCM layout, asetrate, both asetnsamples padding modes and apad) now execute separately with the original native FATE helper and an adapted Edge executor. This does not include generated Make targets.
- Linux reference build/extraction/differential CI configured; remote execution is not yet verified.
- An [isolated Docker build](linux-reference.md) pins a Linux x86_64 image digest and preserves the host oracle. This supplies an additional reference for platform comparisons; reproducible binary identity and Linux conformance are not yet verified.
- The first Linux x86_64 build completed locally under QEMU. In 140 inverse-pixel cases, all explicit scalar outputs matched, while 24 native-default outputs differed; MMXEXT-disabled diagnostic controls removed those differences. Inline MMXEXT remains enabled despite disabling external x86 assembly. Default Linux pixel arithmetic is incomplete; the fixture and scope are recorded in [Linux reference evidence](linux-reference.md).
- An explicit portable `x86_64` inverse profile now models the fixed Linux default MMXEXT packed paths, approximate chroma selection, signed multiply-high rounding and final-two-row C fallback. Fresh expanded comparisons passed 560 default and 560 scalar raw cases, with native fixtures, actual launcher and bounded local workerd coverage. Default profile selection, multi-frame/time/framecrc Linux differential conformance and full reference CI remain incomplete.
- A subsequent Linux experiment passed all 4,480 two-frame comparisons across default/scalar arithmetic, full/output-time selection and raw/framecrc, with a stable oracle. Locked hashes now drive a 4,480-case portable integration regression. `reference:probe:linux-time` supports preparation, validation, native execution and finalization as separate stages. General seek/time/rate conformance, the API default profile and full remote reference CI remain incomplete.
- On 2026-11-20, `npm run check` passed in the pinned Linux x86_64 container under local QEMU emulation: all four TypeScript configurations, ESLint, package boundaries and 194 unit tests. This is local foundation evidence, not remote CI or native differential conformance; see `.build/linux-x64/foundation.log` and `foundation-result.json`.
- Local Linux x86_64/QEMU workerd tests passed all 72 cases with an explicit 30-second harness timeout. The ordinary 5-second invocation first produced 69 passes and three timeouts (initial R2 read, multipart upload and conditional publication); both logs are retained in `.build/linux-x64/`. Assertions and numeric profiles were unchanged. This diagnostic does not establish the ordinary CI timing gate or production Workers conformance.
- Native-dependent inverse comparisons now validate the reference artifact, lock and flags before choosing its explicit arithmetic profile. Unknown target profiles fail explicitly; native default CPU options remain unchanged. All 26 integration tests passed against the Linux oracle under QEMU with a 30-second diagnostic harness timeout. This is separate from an ordinary remote CI timing gate; logs and provenance are in `.build/linux-x64/integration-profile*`.
- Native-dependent integration tests run inside the reference job's compatibility report, after `reference:build`; foundation runs the reference-independent checks only. Current inverse pixel comparisons include AArch64-specific arithmetic and a locally pinned instability fixture, so a passing macOS report does not establish Linux x86_64 conformance.
- Rational arithmetic, bigint timestamp rescaling, packet/frame contracts.
- CLI parser subset preserving file option order and input/output scopes.
- Runtime-independent VFS contracts and explicit allocation accounting/cancellation.
- Reservation-based bounded packet queue: reserve capacity before producing data, bounded payload-free producer waiters, ordered delivery, cancellation cleanup and early-consumer-exit cleanup.
- [Finite audio container mutation checks](container-fuzz.md): 3,306 reproducible WAV/AIFF/AU parser runs bound physical reads, short reads, packet output and read-operation counts; 27 cancellation scenarios retain the abort reason. Coverage-guided fuzzing and CPU/heap watchdogs remain incomplete.
- Package boundary inspection using the TypeScript AST: imports/re-exports/type imports/dynamic imports, declared dependencies, public workspace entry points, relative escapes and dependency cycles.

## Compatibility evidence

The integrated streamcopy/signed-video-time report completed on 2026-11-21 at
08:36:35 UTC with 946 passing tests (489 unit, 50 integration, 238 differential
and 169 local workerd), all 410 scoped contracts and all 14 report gates passing.
Both source and reference snapshots remained stable. The archived run is
`.build/evidence/2026-11-21T07-59-00.432Z-e9de5cf2-76a8-4af6-9a34-e9194e55eeec/`.
Its `compatibilityCertified` field remains false. This report predates the later
copyts/default-sync integration; a fresh full report is required for that source.

The actor-backend package migration is now integrated as the explicit
`createTimedVideoBackend` API, with the portable event codec in avformat and generic
R2 spooling in storage-r2. Existing backend factories retain their behavior.
The canonical corpus adds 1,134 Native framecrc outputs for fourteen formats,
twenty-seven crop/aspect/scale/chain configurations and frame limits 0/1/4, compared
through public packages on Node and local workerd/R2. Eleven injected VFS outcomes
verify publication accounting and disposal on both runtimes. The 946-test report
above covers the actor, simple-video and option-order integrations. Earlier staging artifacts remain in `.build/promotions/`; they are development history.
Ordinary `-vf`/`-filter` video options and scoped automatic/present numeric stream
maps are now integrated. Input metadata handles are acquired once and retained for
source-generation checks. The 1,369-job canonical Native corpus covers option/time
scopes and 720 repeated-PTS duration jobs; 42 selector boundaries include base-zero
indices and signed32 narrowing. The deadline limiter now waits for an actual frame
outside the limit, retaining equal-PTS frames still within the duration. Existing
unit/integration staging evidence preceded this integration; the 946-test report
above covers the ordinary CLI path. Later changes require their own fresh report.
See [timed video backend scope](timed-video-backend.md). Distributed recovery,
full CPU/heap enforcement, production runtime and project-wide license certification
remain unfinished.

- Automated development report with separate capability states, scoped native contracts, suite outcomes and known differences.
- Source snapshots, per-command/test hashes and before/after native artifact checks prevent stale evidence from passing.
- Reference extraction validates source/build lock, configure flags and ffmpeg/ffprobe artifact hashes.
- Fresh per-run evidence and failure reports are uploaded by reference CI; full compatibility is never inferred from passing development checks.
- See [report semantics](compatibility-report.md). Reproducible toolchain pinning and production verification remain incomplete.

## Container foundation

- Partial finite RIFF/WAVE PCM demux, including integer/float PCM and standard extensible subtypes.
- Bounded range reads, unknown-chunk skipping, sample timestamps and exact sample seeks.
- Finite PCM WAV mux with known sample count, bounded writes, contiguous timestamp validation, backpressure and output commit/abort handling.
- Native differential coverage for six encodings, including reading EdgeFFmpeg output back through native FFmpeg; workerd/R2 read and small-sink remux tests.
- See [WAV support](wav-support.md) for tested scope and known differences.

## PCM codec foundation

- Six packed PCM decoder/encoder pairs; four integer depths support direct depth conversion without dither.
- Floating same-format payload preservation plus scoped scalar cross-format conversion are implemented through swresample.
- All 36 PCM format pairs match native scalar-dispatch fixtures; default SIMD and exceptional-value gaps remain explicit. See [sample format conversion](sample-format-conversion.md).
- Explicit per-buffer allocation bounds and cooperative cancellation.
- Native comparison for 16 integer conversion pairs and both float precisions; all six pairs exercised in workerd.
- WAV CLI encoding and R2-backed integer conversion are available; see [PCM scope](pcm-support.md).

## CLI execution foundation

- Core FFmpeg.exec with explicit backend injection, cancellation, structured results and preserved failure causes.
- WAV backend supports the documented single-input/single-output PCM stream-copy and explicit PCM encoding argv subset.
- Unsupported options fail before I/O; default/-n/-y output policy is passed per transaction.
- Development CLI launcher runs the same TypeScript implementation with no native fallback.
- Native six-codec comparison and workerd execution tests cover the frontend path.
- See [CLI execution scope](cli-execution.md); general stream selection, compressed encoding and graph scheduling remain unimplemented.

## Raw PCM foundation

- Six finite headerless input/output formats with explicit CLI rate/channel declarations.
- WAV/raw default codec selection; input defaults 44100 Hz/mono and validated unchanged output declarations.
- Native six-by-six matrix, channel metadata, copy and timing comparisons; workerd/R2 filtered raw output.
- createMediaBackend is the current factory; createWavBackend remains an alias.
- See [raw PCM scope](raw-pcm.md); live streams, resampling/general remix and full probing remain incomplete.

## Audio filter foundation

- Bounded packed audio chains with anull and constant numeric/dB volume.
- Fixed/float/double precision, Q8 rounding and clipping, bounded linear-chain format negotiation, operator ordering, metadata preservation and explicit unsupported-option checks.
- Native exact-PCM comparison for 288 source/target/chain combinations; dB uses a declared numerical tolerance.
- Scoped scalar clipping now accepts finite magnitude <= 32768 for ordinary amplification.
- R2 persistence and late failure cleanup are tested; see [filter scope](audio-filters.md).

## PCM time-selection foundation

- Integer-microsecond decimal/clock/unit parsing with bigint arithmetic.
- Input/output -ss/-t/-to, scope/precedence, sample rebasing and known output length.
- Native packet-bound copy selection independent of physical read-buffer size.
- Differential coverage at 10/8000/44100 Hz and a workerd/R2 timing test.
- Input seeking at/beyond EOF remains explicitly unsupported; native buffered fallback is recorded as a diagnostic gap. See [time semantics](time-selection.md).

## Local filesystem foundation

- Node-only adapter with bounded bigint-offset reads and input snapshot validation.
- Staged sequential writes with no-clobber publication by default, explicit overwrite, commit/abort state handling and published-cleanup error reporting.
- Seven real-filesystem integration tests; native WAV differential tests use actual adapter input/output files.
- Dedicated Node typecheck keeps Node globals out of Core/Workers checks.
- See [Node filesystem semantics](node-filesystem.md), including filesystem trust and crash-durability limits.

## Registry and graph planning

- Immutable feature metadata registry with explicit runtime support and typed resolution failures.
- Structural single-worker graph planning: typed pads, required connections, topological order, cycle checks, memory lower bounds and aggregate queue slot limits.
- Operator traits for future distribution/checkpoint decisions; no distribution or execution guarantee is inferred from metadata.
- Compatibility status claims require test references; registration does not verify those references.
- General CLI-to-graph planning, stream selection, format negotiation and executable graph operators remain unimplemented. The WAV backend uses a direct sequential copy/PCM conversion path with scoped time selection.

## Cloudflare foundation

- Per-execution runtime adapter with Core filesystem and allocation context.
- R2 VFS with opt-in staged output: explicit mounts, bounded range reads, ETag conditions and generation validation.
- Traversal rejection, cancellation boundaries and EOF behavior.
- Local workerd integration tests include packet backpressure, graph planning and staged R2 media execution. Wrangler dry-run bundle succeeds.
- Generated binding types; dedicated Workers typecheck excludes DOM/Node globals.
- Compatibility date 2026-11-18 matches the installed workerd release. Miniflare is pinned to the same prerelease as Wrangler (the npm latest tag currently points to an older release).
- Staged Multipart output with explicit writable mounts, conditional publication, abort and transaction-marker recovery is implemented; see [R2 output](r2-output.md).
- Read-ahead/cache, checksum verification, automatic crash recovery and random-access output remain unimplemented.
- Runtime checkpoint currently checks cancellation only; it does not serialize state or observe CPU time.
- No deployed Cloudflare resources were created.

## Remaining Phase 0 / first development change set

- Reproducible Linux reference environment, compiler and build artifact pinning.
- Expand capability parser validation beyond current representative fixtures and real listing smoke checks.
- Expand FATE execution beyond the four reviewed generated-PCM cases and pin external dataset hashes. Explicit CMD inventory is available; generated targets remain unresolved.
- Full conformance CI gates. Package boundary checks and ESLint (including floating promises) now run in foundation CI.
- Production Cloudflare verification. Local workerd integration tests cover R2 reads and Core allocation accounting; they do not prove production limits or codec support.

## Remaining Phase 1

- Full CLI option catalog and semantics, stream selection and CLI-to-graph execution planning. Structural graph validation is implemented.
- Executable operator registries, frame ownership lifecycle and media-graph scheduling. Metadata registry is implemented. Queue backpressure is implemented as a primitive.
- CPU-time observation and aggregate packet budget enforcement across scheduler queues. Individual queues enforce their explicit capacity.
- Writable random-access files and complete crash/job-state recovery. Local Node and R2 staged sequential output are implemented.

Allocation accounting covers owned buffers only. Releasing a buffer relinquishes ownership; callers must stop using it. This does not prove JavaScript/Wasm peak memory bounds. CPU limits and aggregate cross-queue packet limits remain contracts until their scheduler is implemented.

Partial PCM codec execution and WAV CLI conversion are implemented as scoped above. Compressed codec execution, general filter graphs and general transcoding remain unimplemented. Default resampling is partial as documented below. No native reference result is sufficient to claim Workers compatibility.

## Packet checksum output

`@edge-ffmpeg/containers` exports `muxFrameCrc` for one PCM audio stream.
It preserves supplied packets or incrementally regroups contiguous PCM chunks
without allocating a whole native packet. The CLI supports `-f framecrc`,
default PCM16, twenty explicit linear/companded PCM encoders and copy. Scoped `-bitexact` or output
`-fflags +bitexact` omits the software header; default output identifies
EdgeFFmpeg. Input-only bitexact does not affect the output header.

Native comparisons cover packet checksums, time selection, copy/encode seek
PTS differences, bounded I/O, WAV/raw input, constant volume, default encoder
and channel-layout descriptions. Workerd tests exercise the container API and
CLI with eight-byte buffers. Side data, extradata, video, general stream layouts
and FATE execution remain pending. Capability status remains partial.


## Layout guessing and first FATE execution

The PCM input frontend accepts nonnegative `-guess_layout_max` thresholds.
It preserves an explicitly unknown layout when guessing is disabled, including
raw PCM counts above two. Framecrc describes such streams as `N channels` and
frames carry the unknown layout through filtering/encoding. Explicit WAV masks
are preserved. Negative thresholds and general channel remix remain unsupported.

`npm run fate:run` executes the reviewed `fate-unknown_layout-pcm` definition,
verifies generated input and original native FATE results, and compares Edge
output byte for byte plus the upstream expected MD5. See [execution scope and
adaptations](fate-execution.md). The asetrate framecrc definition also executes; other definitions remain unexecuted.


Fixed volume supports nonnegative gain through 65535 (negative fixed gain is
muted), with larger native overflow profiles explicitly pending. The CLI now
checks float-to-integer conversions inside mixed chains, not only at output.
See [audio filter scope](audio-filters.md) for format negotiation and evidence.


## PCM output frame counts

Scoped output `-frames:a` and matching single-stream aliases now limit native
semantic PCM packet counts, independently of I/O chunk sizes. The calculation
shares seek/re-encode/copy boundary information with framecrc. Decimal signed
int64 values are parsed with bigint; zero is empty and negative is unlimited.
See [frame-count scope and evidence](frame-limits.md).


## Rate reinterpretation and second FATE helper

`asetrate` changes playback rate/time base without changing PCM samples. The
single-stream backend applies input/output time options in their respective
rates and preserves native input packet framing for `-frames:a`. See
[asetrate scope](asetrate.md). General resampler options remain incomplete; scoped default resampling is described below.

Reviewed FATE execution now covers both md5 and framecrc helpers. Profiles are
registered in `compat/fate/profiles.json`; all registered cases must pass fresh
provenance/expected-output checks. `fate-filter-asetrate` uses its original
pinned generated WAV, native Make target and complete upstream text reference.


## Stateful streaming filter path

`AudioFilterChain.process` and `reframeAudio` now execute asetnsamples FIFOs with
bounded frames, per-execution state, backpressure, owned output and sample PTS.
The CLI plans padding counts and applies output timing/packet limits after these
filters. Stateless chains continue to use direct seek optimizations. See
[streaming scope](asetnsamples.md). General graph scheduling, checkpointing and
aggregate memory observation remain incomplete.

Reviewed FATE execution includes pad/nopad asetnsamples cases, bringing the
required profile count to four. Other explicit definitions remain unexecuted.


## Aggregate PCM payload planning

The sequential backend now preflights simultaneous payload reservations, counts
FIFO/conversion/handoff work and reduces physical packet sizes to fit the
configured policy. Fixed-work excess fails before data reads or output creation.
The exported plan has explicit components and scope. See [memory planning](pcm-memory-planning.md).
This extends per-buffer checks; heap/GC, external adaptor buffers, dynamic
allocator integration and actual peak resident-memory observation remain pending.


## G.711 companding

A-law/mu-law codecs, raw formats and finite WAV tags/fact metadata are implemented
in the existing single-stream path. Native/workerd tests cover every codeword
and signed16 encoder value, plus linear/companded CLI conversions and native
WAV interoperability. See [G.711 scope](g711.md). General compressed audio,
resampling and production conformance remain incomplete.


## PCM representation coverage

Twelve more wire representations add signed8, unsigned16/24/32 and big-endian
integer/float PCM. The raw/codec path now supports twenty formats. Byte-order
operations preserve same-precision floating payload bits. WAV keeps its separate
eight-codec allowlist and rejects unsupported representations before output.
See [representation scope](pcm-representations.md) for domain and runtime evidence.


## AIFF/AIFC container path

The frontend now detects WAV/AIFF magic independently of extension, supports
nine AIFF/AIFC codec tags and uses the native AIFF 4096-byte demux packet profile
for time/frame planning. Known sizes, integer extended rates, sound offsets,
selected layouts and staged output are implemented. See [AIFF scope](aiff-support.md)
for complete-file native comparisons, EOF seek behavior and workerd/R2 evidence.
The overall container registry and graph planner remain partial.

## Mono/stereo remix

Canonical one/two-channel conversion now runs after audio filters across supported raw, WAV, AIFF and framecrc output. Fixed16 and explicit separate/fused floating arithmetic profiles have native differential and local workerd coverage. General matrices, resampling and canonical-platform certification remain incomplete. See [scope and evidence](channel-remix.md).

## AU container

Eight PCM/G.711 AU encodings now support finite bounded reading, annotation skipping, sequential known-size output, auto-detection and CLI time/copy/filter integration. Whole-file, decoded-sample, packet timing and local workerd/R2 evidence is described in [AU scope](au-support.md). Malformed length equivalence, ADPCM, metadata and live streams remain incomplete.

## Resampling core

An independent default Kaiser FIR now resamples packed s16/flt/dbl streams with bounded state, exact rational phases, reflected boundaries, short-input draining and bigint PTS. Six-rate-pair and 480 short-input native numerical comparisons, partition invariance, resource checks and local workerd evidence are documented in [resampling scope](resampling.md). CLI output -ar now accepts all supported PCM/G.711 inputs into supported PCM/G.711 encoders through the selected s16/flt/dbl processing path, including phase interpolation fallback and transformed mux counts. The aresample filter, non-default internal formats and full resampler options remain outstanding; no aresample filter capability is certified.

Float FIR coefficient/history storage uses four-byte elements and precision-preserving filters. Native numerical coverage includes 320 raw representation/output combinations and 18 filter/time profiles; local workerd/R2 covers G.711-to-floating AU. Float fixture tolerance is 1e-6, while existing double-to-double fixtures retain 2e-12. Supported linear mixed-format filter placement is now integrated; complex graph placement remains incomplete.

Fixed signed16 FIR now has strict native byte comparisons for quantization, clipping, interpolation, short streams and full-domain input streams. The CLI selects native default internal precision, supports all twenty raw output representations, and has 1600 matrix plus 156 integer container/timing cases. Fixed integer volume is accepted when it preserves source format. Workerd/R2 verifies unsigned8-to-default-signed16 WAV. See [complete scope and tolerances](resampling.md).

Mixed-precision resampling placement now has an immutable filter-chain `rateBoundary` planning API. Seven pinned-native graph-diagnostic comparisons verify the insertion destination, formats and rates across volume precision transitions and asetrate constraints. The CLI now executes this plan with bounded insertion, per-boundary FIR precision, ordered sample-count propagation and negotiated format conversion. A 120-case execution matrix and local workerd impulse/FIFO case verify the supported scope. Complex graphs and combined channel remix remain incomplete.

Mixed-format draining now has an additional 216 native differential cases covering one-sample input, stereo, multiple asetrate constraints and FIFO placement on both sides of precision changes. Iterator lifecycle tests prove input closes on inserted conversion failure or early consumer termination.

## aformat

Singleton packed sample-format constraints now integrate with fixed/float/double volume negotiation, FIFO, asetrate and CLI resampling. Native 96-case numerical and 50-case byte-exact framecrc evidence, unit limits/ownership and local workerd scope are described in [aformat support](aformat.md). Lists, planar formats, rate/layout constraints and full filter compatibility remain incomplete.

## Planar conversion core

The sample converter now supports u8p/s16p/s32p/fltp/dblp, single-pass layout/precision conversion and total-plane allocation budgets. Native 300-variant byte comparisons, ownership/payload/validation checks and local workerd conversion/linear-PCM encoding are documented in [planar audio](planar-audio.md). Filters, FIR, rematrix and CLI planar negotiation remain incomplete.

G.711 now directly encodes signed16 planar channels without repacking scratch. Six native full-domain/multichannel comparisons and local workerd verify output bytes, ordering and bigint PTS; malformed plane checks and output-only allocation budgets have unit coverage.

The standalone audio FIFO now handles planar frames directly, with aggregate input/output budgets, per-channel padding, exact bigint PTS and fresh output storage. Thirty native cases under three input partitions plus local workerd and lifecycle/error tests verify this scope. General planar filter graphs and CLI negotiation remain incomplete.

The FIR library now reads s16p/fltp/dblp planes directly and emits owned planar output without interleaving scratch. Native 54-case/162-partition comparisons and local workerd verify counts, per-channel values and precision-specific tolerances. CLI planar negotiation and general filter/rematrix support remain incomplete.

Mono/stereo rematrix now accepts all packed/planar precision combinations. Two hundred strict native variants verify packing-independent internal precision, channel order and destination normalization. Unit ownership/rounding/budget checks and local workerd planar downmix/upmix cover the library scope; general multichannel and combined rate/channel conversion remain incomplete.

Linear filter execution now accepts planar input, preserving layout through metadata-only operators and FIFO, and converting to packed precision for volume or packed aformat. Ninety strict native chain cases, validation/ownership unit checks and local workerd cover the library path. CLI planar constraints and global negotiation remain incomplete.

CLI singleton planar aformat constraints now connect the planar building blocks across filters, FIFO, encoding and scoped automatic resampling. All-plane trim fixes channel slicing for timed planar output. Another 168 native rate cases, 50 exact framecrc cases and a workerd 141-sample packing-dependent rate-placement fixture verify the scope. General format preference lists and complex graph negotiation remain incomplete.

## Audio FATE candidate audit

A source-verified static audit now classifies all 79 explicit audio-filter FATE definitions against the current compiler and records unsupported dependencies and review requirements. It retains unsupported operators such as aperms=random rather than adapting them away. The compatibility pipeline runs the audit independently of execution; the reviewed executed FATE count remains four. See [audit scope](fate-audio-candidates.md).

## Finite audio padding

A standalone padAudio API now appends finite silence using bounded packed/planar packets, preserving input packet boundaries and bigint timestamps. Ninety native packet/checksum cases plus resource/lifecycle checks and local workerd cover the core. CLI apad and the original fate-filter-apad target are connected as described below. See [padding scope](audio-padding.md).

Finite CLI apad now preserves native tail packet sections across arbitrary physical I/O chunks, FIFO, planar constraints and nested padding. Sixty complete framecrc cases plus workerd cover the scoped path. The original fate-filter-apad target passes native Make, upstream expected bytes and Edge output with hash-locked generated WAV/helper provenance, increasing reviewed FATE execution to five cases. Extended finite padding modes and output selection are described below; infinite padding and resampling combinations remain incomplete.

Minimum-total apad whole_len now uses the actual sample deficit through FIFO/nested-padding count propagation. Zero deficits allocate no silence; small deficits do not reserve a full default 4096-sample packet. Ninety-six exact native framecrc cases, eight-byte CLI budget checks and workerd cover the new path. Duration modes and output selection are described below; infinite padding and resampling combinations remain incomplete.

Finite apad pad_dur/whole_dur now retain bigint microseconds and resolve at each operator rate with nearest-sample rounding. Count/section/buffer planners propagate asetrate in order. Native 240-case whole-framecrc comparisons, boundary unit checks and local workerd verify the scope; duration parsing is shared in avutil with CLI re-export. Output selection is described below; infinite padding and resampling composition remain incomplete.

Finite apad now supports output seek/duration/stop selection across input and silence packet sections, with per-section first-packet lengths and all-plane slicing. Native 128 complete-framecrc and 36 container/decode cases plus bigint/invalid-section unit tests and workerd verify the scope. Frame limits and positive sub-sample output durations are described below; actual resampling and infinite padding remain incomplete.

Finite apad output frame limits and positive sub-sample output durations now use bounded bigint packet-section arithmetic after time selection. Native 208 short-fixture and 80 multi-packet raw/AIFF whole-framecrc cases, partial-head/large-count unit checks and local workerd verify this scope. Actual resampling composition and infinite padding remain incomplete.

Finite apad now composes with automatic FIR rate conversion before/after negotiated format boundaries. Shared count/buffer planning uses actual post-conversion counts and stage rates; configured format descriptors allow padding after a zero-sample drain and on empty CLI inputs. Native evidence adds 1800 raw numerical/count cases, 288 container/timing cases and 72 exact empty-input framecrc cases; unit/resource checks and local workerd cover the EOF path. Semantic resampler packet scheduling is described below; simultaneous channel remix, infinite padding and complex graphs remain incomplete.

Finite automatic FIR now has independent semantic packet schedules with bounded bigint run formulas, zero-output input packet compression, native startup output-allocation overflow and 4096-sample drains. Output frame limits, partial-first seeks, positive sub-sample timing and framecrc use these schedules regardless of physical chunk size. Evidence adds 248 native plan scenarios, 1152 numerical CLI cases, 384 silent framecrc scenarios under two budgets, 144 nonzero fixed-point whole-framecrc cases and 144 container-input/raw-WAV-output cases, plus local workerd. Fixed Q15 coefficient conversion now includes the native float32 intermediate; long stereo fixtures catch the prior one-LSB errors. Empty configured-source padding reserves generated frame payloads before output creation. Floating checksum identity, extreme bounded-rational approximation, simultaneous remix and general conformance remain unverified.

## Initial video execution

The video phase now has fourteen declared 8-bit pixel layouts with odd-chroma geometry, owned rawvideo decode/encode, positive padded-stride row packing, finite headerless I/O and video framecrc. createMediaBackend routes explicit rawvideo input with rational/named frame rates, scoped frame limits, codec aliases, mapping and staged output. Native 3024 byte/framecrc comparisons plus 324 default/alias/empty/short-read cases pass; unit/resource/lifecycle checks, the actual Node CLI launcher and local workerd/R2 staging verify the path. Frame storage is preflighted against conservative simultaneous payload reservations. General compressed video, pixel/color conversion, scaling, video filters, frame-rate conversion, non-default metadata and production verification remain incomplete. See [rawvideo scope](raw-video.md).

Rawvideo scoped input/output `-ss`, `-t`, `-to` now follow separate copy and decode/encode timing plans. Native differential cases cover half-frame and microsecond boundaries, EOF fallback, explicit zero seek, encoder deadline and default high-rate probe packet duration transitions. See raw-video.md for scope and limitations.

The new portable swscale package provides component-preserving RGB packed/planar and YUV420 planar/semi-planar conversion with explicit alpha policy, positive padded strides, owned output and bigint PTS preservation. CLI -pix_fmt uses this path before rawvideo encoding; output layout growth and simultaneous payloads are preflighted. Native evidence adds 2856 byte/framecrc comparisons and 136 empty-stream cases, plus unit, actual launcher and local workerd/R2 staging tests. This is partial pixel conversion; color/range matrices, chroma resampling, scaling, negative strides, compressed video and production resource verification remain incomplete.

Default BT.601 color conversion adds forty RGB/YUV444/gray paths with exact Q15/Q13 intermediate/range rounding and explicit native signed-32 inverse behavior. Native evidence adds 1680 whole raw/framecrc scenarios plus 120 ramp/random cases, unit anchors, actual CLI and local workerd/R2 staging. [Color scope](pixel-color.md) records provenance, default assumptions and unverified color matrices, RGB/subsampled-YUV paths, chroma resampling, HDR and production runtime behavior.

Default bicubic chroma resampling now connects all six YUV layouts and all seven RGB inputs to subsampled YUV. Native evidence adds 1152 YUV-pair and 1120 RGB-forward scenarios, explicit filter/workspace budgets, unit anchors, actual launcher and workerd/R2 tests. The adapted chroma-filter.ts component carries LGPL-2.1-or-later provenance and license notices. Subsampled YUV-to-RGB, arbitrary scaling, custom matrices/ranges and production resource verification remain incomplete. See [chroma scope](chroma-resampling.md).

Subsampled YUV-to-RGB now has explicit aarch64/scalar arithmetic profiles and generic fractional interpolation, with 2128 default and 560 scalar native comparisons, unit/actual-CLI/workerd/R2 evidence. A measured nondeterministic aligned even-height default NV12/NV21 path is rejected before I/O and tracked by a pinned behavior fixture plus a separate diagnostic contract. Canonical default SIMD behavior, unwritten native tail allocation states, scaling and production conformance remain unverified. See [inverse scope](pixel-inverse.md).

## Gray video resizing

The fixed-default gray/gray8 resizer and rawvideo output-size CLI path now handle arbitrary positive resize ratios within frame/state budgets. Shared bicubic coefficient generation uses on-demand bigint weights, and gray evaluation retains one signed32 accumulation row. Native evidence covers 600 default/scalar raw cases, 518 full CLI outputs, ten actual Node-launcher outputs and local workerd/R2 framecrc with staging cleanup. Input/output size scope, copy ignoring output sizes, zero-frame/time output and pre-I/O resource checks are explicit. YUV extensions are described below. RGB formats, video filter graphs, aspect/color metadata, general conformance and production measurements remain incomplete. See [scope and evidence](pixel-resize.md).

## YUV video resizing

Same-format output-size resizing now covers YUV420P, YUV422P, YUV444P, YUVA420P, NV12 and NV21. Axis tables are shared across matching plane dimensions and UV components; one accumulation row is reused. Aggregate padded input storage and all workspace payloads are bounded before processing. Native evidence adds 3,600 raw API comparisons and 2,784 whole CLI time/framecrc comparisons; actual Node and local workerd/R2 paths cover sixty outputs and six staged outputs respectively. A supplementary pinned Linux x86_64 run matched 288 default/scalar raw comparisons. RGB resizing, combined color conversion/resizing, video filter graphs, metadata transformation and production performance remain incomplete. See [scope and evidence](pixel-resize.md).

## Native video size syntax

Input and encoded output dimensions share a parser for all 55 pinned FFmpeg size names and LP64 decimal/separator semantics. Layout/resource preflight remains mandatory; streamcopy still ignores output sizes. Evidence includes 62 empty-input native framecrc outputs, five nonempty named/numeric output cases, fourteen pre-I/O malformed cases, actual Node raw/framecrc and colon-separated workerd/R2 execution. This extends syntax coverage without claiming large-resolution performance or generic filter graphs.

## Linear video filter execution

A portable bounded chain planner and frame executor now connect null and constant-size scale to rawvideo CLI aliases. Output -s appends scaling after the chain. Intermediate frame/workspace payload is preflighted before I/O; streamcopy/filter combinations, expressions, branches and combined format negotiation fail explicitly. Evidence includes 504 native raw/framecrc comparisons, eight actual Node outputs, local workerd/R2 with staging cleanup and resource/ownership/cancellation unit tests. General graphs and production verification remain incomplete. See [video filter scope](video-filters.md).

## RGB resize integration

All seven RGB layouts now resize through Q6 internal YUV, bounded shared axes and three/four accumulation rows, including packed alpha expansion, GBRP rounding and identity copies. Public API evidence adds 4200 native default/scalar raw comparisons, CLI 3248 time/framecrc outputs, 96 alpha endpoint cases, seventy Node outputs and seven local workerd/R2 anchors. Filter-chain coverage now compares 840 native outputs. A fresh Linux x86_64 public-API probe matched all 336 default/scalar raw cases. Combined format conversion/resizing and general color/metadata/kernel behavior remain incomplete. See [numeric scope](pixel-resize.md).

## Fused size and format transformation

The resize API and standalone CLI output sizing now directly transform 154 format pairs with outputPixelFormat, shared component axes, pre-vertical range conversion and Q9 gray-to-RGB rounding. Equal-size requests delegate to established conversion paths; explicit filter format negotiation and geometry-changing YUV-to-RGB remain incomplete. Evidence: 14784 native API raw comparisons, 3696 whole CLI raw/framecrc outputs, thirty-two actual Node outputs and eight local workerd/R2 anchors, plus padded/budget/ownership and unscaled-delegation unit checks. See [scope](pixel-resize.md).

Supplementary fused-transform Linux x86_64 validation matched 616 default/scalar public-API raw comparisons across all 154 pairs at two geometry combinations; provenance and observations are archived.

## Resized inverse profiles

YUV-to-RGB resizing now uses bounded full-Q9/table rows with native vertical dispatch and explicit Linux MMXEXT emulation, including signed16 bilinear deltas, alpha truncation and final-two-row C fallback. The full API matrix expands to 196 pairs with 18816 native default/scalar raw comparisons and 4704 whole CLI time/framecrc outputs. Locked Linux regression covers 1008 default and 1008 scalar resized inverse outputs; Node adds 252 fresh native whole outputs and twelve explicit-profile/scalar locked outputs. Two local workerd/R2 profiles match 84 fresh native framecrc anchors. Unscaled semiplanar instability guards are preserved; general filter negotiation and production verification remain incomplete.

## Linear format negotiation

Video plans now bind output and single-format constraints to the proper scale anchors, insert unchanged-size conversion when needed, append output -s and preserve implicit final formats. Identity scales remain negotiation anchors before execution simplification. Plans expose immutable stages and fixed arithmetic; frame/workspace/intermediate-format budgets are checked before I/O. Native evidence adds 14112 negotiated raw API comparisons, 7056 constrained API comparisons, 1152 timed CLI outputs, 896 implicit/empty/zero outputs, 128 actual Node outputs and sixteen dual-profile workerd/R2 anchors. Declared-format candidate lists now negotiate shared sets, preserve chroma/alpha boundaries and reject duplicate canonical candidates before I/O. Another 2048 native CLI outputs, 256 actual Node outputs and sixteen dual-profile local workerd/R2 anchors cover this scope. Color-space/range options and general graph negotiation remain incomplete; fixed-reference numeric parsing is described below. See [scope](video-filters.md).


## Spatial reflection and empty filter defaults

Linear video graphs now support hflip/vflip across all fourteen declared layouts.
Owned tight positive-stride output preserves packed pixel components and UV pairs;
odd chroma dimensions, exact bigint PTS, padded input budgets and cancellation are
explicit. Reflections share candidate sets with connected format-preserving nodes
and reserve each intermediate frame without coefficient workspace.

Scoped evidence includes 448 native helper outputs, 20160 complete mixed graph
outputs under default/scalar arithmetic, 2048 CLI outputs, 256 actual Node outputs
and sixteen dual-profile local workerd/R2 framecrc anchors. Empty whole-option
null=/scale=/format=/hflip=/vflip= defaults have another 4200 native API outputs.
Negative-stride API input, arbitrary side data, timeline expressions, general
graphs and production Workers verification remain incomplete. Numeric/empty
candidate parsing is described below. See [current scope](video-filters.md).


## Fixed-reference numeric format candidates

The format filter now models LP64 base-zero integer conversion, signed32 enum
storage, explicit empty candidate elements and native gray/fixed-LE aliases for
the fourteen declared layouts. ASCII filter/key whitespace and candidate-level
validation retain native distinctions; canonical duplicates fail before I/O.
Integer work stays bounded after saturation. Numeric IDs outside these layouts,
labels/multiple chains, additional format options and other ABI profiles
remain incomplete.

Evidence covers 12600 mixed graph outputs, 98 spelling/boundary checks with implicit
raw output, 2048 timed/empty CLI outputs, 256 actual Node outputs and sixteen
dual-profile local workerd/R2 framecrc anchors. Preflight checks reject numeric
errors and intermediate budget expansion before any handles open. These are
scoped tests, not full format/error or production Workers certification. See
[format-token scope](video-filters.md).


## Linear filter lexical semantics

Linear video parsing now uses separate native-style token and option layers for
single quotes, backslashes and protected whitespace. Named arguments disable
remaining shorthand; final string fields determine dimensions, format and flags.
Terminal separators, native unclosed-quote behavior, comma size syntax and
height-only constant scaling are included. Labels, general topology, expressions,
other options and production verification remain incomplete.

Scoped evidence adds 18480 complete native graph outputs, 45 output/rejection
cases, 2048 CLI outputs, 256 actual Node outputs and sixteen local workerd/R2
anchors. Another 2048 recorded ASCII function vectors have pinned origin hashes
and a regeneration tool. All input/operator and intermediate resource limits
remain explicit. See [current syntax scope](video-filters.md).

## Public bounded frame FIFO

The public `@edge-ffmpeg/avutil` queue now supports owned cross-stream frames,
per-stream finish markers, choke state, bounded cooperative waiters and cleanup
fault reporting. It is a kernel for scheduler integration; the full CLI actor /
producer scheduler remains experimental. Accepted accounting and release fields
are snapshotted so a later caller-side field change cannot corrupt byte totals.

Scoped evidence consists of six ownership/lifecycle tests and 120 cached host
Native traces / 15,416 transitions, compared through the public API on Node and
local workerd. Native threads, full scheduler admission, Linux behavior, complete
heap/CPU accounting and production Workers are separate requirements. See
[the queue contract and regeneration procedure](thread-frame-queue.md).

## Public video encoder synchronization queue

`createVideoEncoderSyncQueue` now exposes the reference-tested video queue
kernel, including limiting streams, frame limits, EOF and overflow heartbeat.
Owned headers/release callbacks, retained byte/frame budgets and stable cleanup
errors are part of its TypeScript contract. Audio sample splitting and the full
CLI actor/task runtime remain unfinished.

Scoped evidence includes 110 cached host Native traces / 21,575 complete
operations compared on Node and local workerd, plus ownership and cleanup tests.
Full trace archives and digest verification preserve every compared field while
keeping runtime tests in small batches. See [the API and evidence scope](encoder-sync-queue.md).

## Public filter enable evaluator

`createFilterEnableTimeline` exposes enable expression state and explicit lifetime
management. Native flip scheduling remains caller-supplied; production CLI graph
registration is unfinished. 48 cached host cases / 384 operations compare full
pixel/reply traces on Node and local workerd. Invalid replacement crashes in the
Native reference are recorded separately and are not certified as matching.
See [the evaluator contract and evidence](filter-enable.md).

## Public timed command queue

`createFilterCommandQueue` now exposes bounded per-node command storage, stable
Native double-time ordering, ONE selection, synchronous processing and disposal.
64 cached host traces / 2752 operations compare all queue entries on Node and
local workerd. Experimental actor command paths now delegate to this public
kernel; full actor/backend promotion and complete CLI transport remain unfinished.
See [the queue contract and regeneration procedure](filter-command-queue.md).

## Public bounded rational reduction

`reduceBoundedRational` provides pinned Native continued-fraction reduction and
exactness reporting. 3,173 host cases match through the public API in Node and
local workerd. Experimental scale/aspect calculations now delegate to this kernel.
`INT64_MIN` remains explicitly rejected because upstream signed absolute value is
undefined there. See [the API scope and regeneration procedure](bounded-rational.md).

## Public number to rational conversion

`numberToBoundedRational` adapts Native av_d2q with explicit IEEE special values
and bounded fraction selection. 14,401 host cases compare every output field in
Node and local workerd. See [the API and regeneration scope](number-rational.md).

## Public scale expression state

`createScaleExpressionState` now supplies bounded single-input init/frame
expression state to experimental scale actors. 484 cached host Native init-mode
command traces / 2,840 operations match complete states in Node/local workerd.
Frame/pixel graph evidence is tracked separately; full backend promotion is open.
See [the API contract and regeneration scope](scale-expression.md).

Public scale frame-mode evidence now includes 224 Native traces / 1,792 operations
for n/t, unknown PTS, persistent/unused expressions, chroma variables and command
replacement. These scoped tests verify projected geometry/replies;
full pixel, graph and CLI backend promotion remain open.

## Video option selection and independent input clocks

Finite rawvideo now preserves last-matching output string options, eager numeric
frame-count validation, and typed input aliases applied after generic format
AVOptions. Physical demux rate, matching forced decoder rate and streamcopy output
clock remain separate, including seek and duration handling. A canonical corpus
contains 2,086 option-order and 800 independent-clock Native jobs, compared through
both backend factories on Node and local workerd/R2. Rejected cases compare only
success/failure classification. Full diagnostic, codec and CLI conformance remain
open. See [regeneration and scope](video-option-order.md).

## Streamcopy and signed video time integration

Finite rawvideo streamcopy now ignores encoder-only pixel/sync/timebase settings,
validates output rate controls and rescales packet timing to explicit output rates
without changing packet count. Its canonical corpus contains 2,520 Native jobs,
covering fourteen declared formats plus the gray8 alias, time/frame limits and
high-rate/coarse-clock behavior. See [streamcopy scope](video-streamcopy.md).

Video input/output seek and stop values may be signed; negative durations remain
rejected and audio time parsing retains its existing scope. Failed negative seeks
retain the Native probe-flush reading position. Forced decoder cadence applies
only after decoding a frame; empty/skipped sources keep physical demux fallback
clocks. A second corpus contains 8,038 Native jobs across single/two-source graphs,
all fourteen formats, empty inputs, rates, durations, frame limits and complete
raw bytes. See [signed-time scope](signed-video-time.md).

Both candidates passed existing 539 unit/integration tests and their full canonical
comparisons through public Node/local-workerd APIs before guarded integration.
The combined candidate also passed the 2,520-case streamcopy replay. Scoped R2
faults cover input generation changes, output-budget failure and cleanup. The
946-test report above covers these two integrations; it does not certify production
Cloudflare, arbitrary graphs/protocols, compressed codecs or full CPU/heap limits.

## Timestamp preservation and default synchronization

Finite rawvideo accepts copyts/start_at_zero and their inverse boolean forms,
including the pinned CLI's ignored suffix semantics for global flags. Preserved
packet clocks remain separate from forced decoder cadence and output seek clocks.
The decoder can initialize from a final physically seekable packet even when
accurate trim removes every frame. Automatic CFR retains Native VSCFR startup
behavior where the original simple source or copyts requires it; explicit CFR
remains explicit. Zero-frame output still obtains correct tentative parameters.

A new corpus contains 10,592 gray rawvideo jobs, compared through public Node and
local workerd/R2 APIs; four input-generation faults cover discarded-frame
initialization. Existing 539 unit/integration tests and 36 earlier canonical tests
passed on the final candidate before guarded promotion. See [timestamp scope and
regeneration](video-copy-ts.md). The stable987-test v17 report covers this integration. This does
not implement audio/compressed timestamp modes, nonzero container start metadata,
arbitrary graph/protocol behavior or full resource/runtime conformance.

## MP4 packet reading foundation

The public containers API now includes scoped non-fragmented MP4 video/audio
packet reading. Eighty-five fixed Native files cover timestamps, full payload
bytes, AAC-LC priming/padding, 64-bit tables and native interleaving through Node
and local workerd/R2. Input generation replacement and bounded parser faults are
tested. See [MP4 scope](mp4-demux.md). General detection, compressed decoding,
fragments and general edit lists remain unfinished; demuxer.mov is partial.
Scoped mux/CLI copy is described below.

## Finite MP4 mux and CLI copy

The public container API and createMediaBackend now connect finite local MP4
packet reading, metadata-only planning and transactional muxing.197 Node and204
local workerd/R2 CLI jobs match pinned Native packet contents/clocks and selected
stream/codec/disposition fields.92 public API copies include seven wide-time
cases; actual Node filesystems and R2 publication recovery are exercised.
See [MP4 mux scope](mp4-mux.md). Both demuxer.mov and muxer.mp4 remain partial;
compressed decoding/encoding, general edits/probing and other documented gaps
remain work toward the unchanged full FFmpeg goal.

The latest fully passing root report (v18, 2026-11-21T10:50:28.827Z) passed1004tests,
448contracts and14gates with stable source/reference. It covers the MP4 mux/CLI
integration. The subsequent selection/language integration requires a fresh full
report. Production/full compatibility certification is false.

## MP4 selection and language metadata

Ordered negative maps, input ID selectors and MDHD language handling extend the
scoped packet-copy path. The candidate passed320negative-map jobs through each
Node/R2 path,1812Node/780R2ID jobs,65536language conversions against pinned C,
and342language CLI jobs through each Node/R2 path. General selector grammar,
metadata, codecs and runtime resource certification remain incomplete.
See [selection scope](mp4-selection.md). A fresh complete root validation is
required for this integration; the full FFmpeg goal is unchanged.

## BMP codec and declared image2pipe

A scoped media engine path adds owned BMP decode/encode packets, explicit RLE
row-capacity profiles and bounded BMP image2pipe parsing with transactional CLI
output. The isolated integration passed20 tests plus28 existing regressions;
production integration requires a new full report. The five BMP/image2pipe
capability entries remain partial. See [BMP scope](bmp.md). The full FFmpeg
compatibility goal and uncertified status are unchanged.

The subsequent v19 root report (2026-11-21T11:36:38.817Z) passed all1030tests
and14gates with stable source/reference, but its overall result failed: one
MP4 language Workers contract used a shortened test name and remained unverified.
The other472contracts passed. The binding is corrected in this integration;
a fresh full report must verify the combined source. The failed v19 evidence is
retained unchanged.

The v20 report (2026-11-21T12:32:11.764Z) retained stable source/reference and
passed508unit,51integration and296differential tests. Workers passed190/196;
six assertions in signed-video-time.test.ts exceeded their unchanged60second
limits. All other gates, including FATE, passed. The original unchanged file
subsequently passed16/16 in isolation (236.86seconds total). The test now connects
Vitest cancellation to request dispatch and stops further iterations after timeout,
with group/case diagnostics, to prevent expired work overlapping later groups.
No deadline or Native case inventory was relaxed. A new full report is required;
v20 remains a failed report rather than a full validation claim.

The v21 full report completed successfully at2026-11-21T13:33:40.570Z
(run2026-11-21T12-49-11.828Z-0467381a-7676-4d36-b5c4-abfed0d33e4b).
All1051tests passed:508unit,51integration,296differential and196Workers.
All494scoped comparison contracts and14gates passed, including the reviewed
FATE profiles; source and reference snapshots stayed stable throughout the run.
This validates the integrated BMP path and cancellation changes within their
recorded scopes. Earlier failed v19/v20 reports remain preserved. Full FFmpeg
compatibility remains uncertified, and the manifest still has163partial and
2336unimplemented entries. Unpromoted MP4-edit and H264 experiments are separate
from this production-tree evidence.

## H264 public API integration (2026-11-22)

The bounded TypeScript AnnexB/AVC decoder API is now exposed by avcodec with
an explicitly supplied trusted precompiled module. LGPL adaptations and
notices are retained.2public API boundary tests and20candidate differential/
lifecycle tests pass; production typecheck passes. This is not CLI decoder
integration or a codec capability promotion. The previous full1051test report
predates these source changes and is not a report for this new tree. Formal
codec build/artifact packaging, contracts and a new full report remain needed.

MP4/H264 CLI prerequisites now include shared streamselection (32existing
Native/Workers tests pass), bounded AVC configuration extraction and Native
MOV-style initialvideo-delay estimation.4complete fixtureMP4 decode results
matchNative with inferred delay; using0unconditionally lost7of9B-stream
frames and is explicitly rejected by retained differential evidence. CLI
decode routing and contracts are still pending.

MP4-to-rawvideo passthrough CLI routing is now connected through an explicitly
supplied codec module.4inputs x4frame-limit cases matchNative through the
public backend and actualNode launcher. Localworkerd/R2 matches16normal
cases and4failure/cancellation/configuration cases, with no orphan staging
objects.2backend pre-I/O boundary tests and launcher module-file validation
pass; existingNode MP4copy regression passes. Formal capability promotion,
full-source release assembly and a current-tree fullreport remain pending.

## H264 report and POC reset follow-up (2026-11-22)

The v22 report completed at2026-11-21T16:11:20.353Z
(run2026-11-21T15-29-30.599Z-736ff897-70a0-48f5-ba17-9c709c37920b).
All1060tests passed:516unit,52integration,296differential and196Workers.
All14gates passed, with sourceStable and referenceStable true. This covers
the preceding API/CLI integration; it does not certify full compatibility.

Subsequent POC1/2 experiments identified an SDK failure when all reference
pictures retain POC0. An isolated progressive-picture calculation and MMCO5
metadata path now match the pinned Native decoder on23owned streams,
471frames, including frame-number wraps, signed deltas, repeated MMCO5 and
multi-slice reset pictures. The same471frames pass localworkerd. These
codec/ABI changes have not replaced the pinned public module or capability
manifest. General recovery and interlaced behavior remain incomplete.

The production display policy now clears history for an explicit reset;
2unit regressions cover inferred delay and a non-key reorder boundary.
The delay regression fails on the preceding implementation. This change
postdates v22, so that report does not validate the current source tree.

The progressive POC1/2 calculation, MMCO5 metadata and versioned ABI2 adapter
are now integrated. Two clean builds and a source-only rebuild produce the
same375241byte module, SHA256
`1b14bb76bdf5629975dccb6096e12b28875ce53f588f05456560c8bdd13af36a`.
The source staging contains372SDK files plus managed build/adapter sources;
final runtime notices/release assembly remain pending.

Formal differential and localworkerd tests now cover47owned streams,
615frames, including24MMCO5/B-direct cases at varied reorder depths.
The committed generators reproduce all47byte streams. The Native test
rebuilds its guarded frame oracle and compares every frozen expected frame
before checking public decoder pixels, metadata, int64 clocks and cleanup.
The codec/decoder manifest entries are partial:165partial,2334unimplemented;
no conformance or general H264 bit-exact certification is asserted.

All519unit tests and2new functional tests pass, along with typecheck,
declarations, lint and boundaries. CI now builds the pinned independent codec
explicitly and passes it with reference artifacts to the Workers job. The CI
definition has not yet been exercised on the canonical host. These changes
postdate v22; a current-source full report is still required.

## H264 wide corpus and pre-copy budget check (2026-11-22)

v23 completed at2026-11-21T17:15:48.881Z
(run2026-11-21T16-36-08.387Z-2d4f614e-460c-470c-92d2-5af164a08eff).
All1065tests passed:519unit,52integration,297differential and197Workers.
All496contracts and14gates passed; source/reference snapshots remained stable.
This report validates the preceding47stream/615frame integration, not the
following changes.

While v23 ran, an isolated work copy expanded the corpus to72self-owned
streams/859Native frames. Moving CAVLC/CABAC, active weighted P prediction,
reference B pictures, spatial/temporal direct modes,8x8 transforms and HD crop
vectors supplement the normative POC/MMCO5 and independently assembled cases.
All72packet streams regenerate byte-for-byte on the recorded host. A fixture-only
OpenH264 encoder rebuild matches its existing pinned Wasm; x264 remains a
developer fixture tool, never a runtime fallback.

Formal MP4 tests now compare26inputs/146mapping and frame-limit cases through
fresh Native FFmpeg, actual Node CLI and R2. Fifteen extra controls include
late NAL/length faults, input mutation, explicit resource exhaustion, preserving
existing files, overwrite success and aborting two uploaded multipart parts.
No orphan staging/upload counters remain. Fault effects are transactional
guarantees, not general Native damaged-output equivalence.

An allocation trace also exposed an AVC prefix copied before its byte-budget
check. The integrated guard rejects it before copying;384boundary combinations
preserve conversion/ownership behavior. The work copy passed all521unit tests,
typecheck, declarations, lint and boundaries, plus the four wide functional
tests. These changes postdate v23 and require a new full report. Generic
`execution-failed` budget diagnostics and broader recovery/field/encoder/runtime
coverage remain incomplete.


## H264 typed resource failures and v24 evidence (2026-11-22)

v24 completed at2026-11-21T18:09:50.820Z, run
2026-11-21T17-29-07.325Z-3cc65b6b-06be-4c7b-aa85-5a9d2159e017.
All1069tests passed:521unit,53integration,297differential and198Workers;
source/reference snapshots remained stable. This validates the wide corpus
and pre-copy guard above, before the following typed-error changes.

The isolated resource-error candidate was promoted only after v24 finished
and all18base/candidate file hashes matched its receipt. H264ResourceError
extends H264InputError and identifies declared resource exhaustion. The MP4
backend maps this class to resource-budget while retaining its cause; it does
not infer categories from message text. Malformed input, cancellation and
output publication/cleanup retain their existing diagnostics. A sixteenth R2
control verifies cleanup acknowledgement failure preserves the original
pending-packet resource cause and leaves no staging objects or uploads.
The integrated tree passes527unit tests, typecheck, declaration generation,
lint and package boundaries. A new full report is required for these changes.

A separate ignored distribution draft inventories the current ABI2 module's
90linked archive members and670translation-unit inputs. All58runtime object
primary source paths and compiler producers match extracted DWARF evidence.
The draft includes full headers, per-file notices and libunwind header notices;
all1083inventoried files were hash-verified. Rebuilding its SDK sources with
the pinned external emsdk runtime/cache reproduces the current Wasm hash.
This is not a self-contained compiler/runtime-source rebuild or publication
clearance. Source-specific licensing review, final assembly, canonical CI,
production runtime verification and full FFmpeg compatibility remain open.


## H264 processing, matrix and framecrc integration (2026-11-22)

v25 completed at2026-11-22T02:57:13.191Z, run
2026-11-22T02-10-42.045Z-de736040-9efd-4a6c-bf9b-40d124f13b81.
All1075tests passed:527unit,53integration,297differential and198Workers.
All498contracts and14gates passed, with stable source/reference snapshots.
This validates the typed-resource integration before the following changes.

After v25 terminated, four isolated candidates were integrated in dependency
order with every base/candidate hash checked.63ordered file copies cover47unique
files; previous files and final hashes are retained in ignored promotion evidence.
The candidates connect bounded spatial filtering/scaling/format conversion,
limited-range YUV matrix profiles, framecrc timing and explicit build-cache choice.
The codec module remains the same375241byte independent ABI2Wasm (SHA1b14...).

Processing contracts include128actual NodeCLI comparisons and18large reductions;
a scalar coefficient-alignment difference previously changed4HD output bytes.
Color contracts include2432direct Native comparisons,32automatic matrix CLI
successes,4Native/candidate BT2020-CL failures,72workerd/R2 comparisons and owned
matrix/range metadata. Full-range RGB remains unfinished; full-range gray luma
now preserves its source range. Both existing unstable semiplanar reference paths
and Native-rejected matrix10 stay explicitly rejected.

Framecrc contracts include324base NodeCLI cases,15derived-clock cases,20aspect
cases,27source-clock tracks and53workerd/R2 comparisons with2rollback controls.
The new parameters snapshot retains active SPS geometry,SAR and nominal rate;
MP4 pasp wins over SPS aspect. Scale/transpose preserve display aspect. Zero-frame
output initializes headers. Native rate probing with399standard candidates fixes
a variable schedule whose average200/9 differs from guessed89/4. These paths
reuse bounded owned frames, encoder timestamp rounding and transactional output.
General CFR/auto modes,all probe termination/parameter-change/TKHD/metadata/error
semantics and production isolate-memory conformance remain unfinished/unverified.

A real empty-cache build regenerated12Emscripten libraries and reproduced1b14.
381sysroot header hashes and all90linked objects after stripping DWARF matched.
The new optional --cache build parameter survives emsdk_env.sh initialization;
its standalone source rebuild was executed successfully. Compiler/LLVM/Binaryen
remain pinned prebuilt components; full toolchain-source reconstruction and final
license/publication approval are not established. Source staging is refreshed
separately from the ignored distribution draft.

The integrated source requires a new full report. Expected counts are1091tests:
528unit,60integration,302differential and201Workers, plus513contracts if all pass.
Capability states remain165partial and2334unimplemented. None is promoted to
conformant or bitexact merely from this scoped evidence; full compatibility is
not certified.


The integrated root passes15functional files/19tests. Typecheck,declarations,
lint and package boundaries passed. The first concurrent check timed out two
unit tests at the unchanged5second limit; an isolated1008-case Linux resize test
passed in1.2seconds. A default-parallel unit-only retry still timed out that test.
The Vitest default now bounds execution to one worker, matching the other suites;
no assertion or timeout was relaxed. All528unit tests then passed (17.88seconds),
with the affected fuzz/resize tests taking0.81/1.57seconds. These are test-runner
resource observations, not production performance guarantees.
The updated389file SDK/build/adapter source staging was hash-verified. A new
v26full report is started for this integrated source; its result is pending.


### Isolated full-range RGB candidate after v26 launch

This section describes the full-range changes integrated after v26 terminated.
V26 did not include these additions. It failed only the Node/workerd timed
transpose aspect regression described below.
Full-range RGB coefficients now cover eight matrix profiles across direct,
filtered and resized output. Legacy yuvj420p/422p/444p inputs force full numeric
range even when frame range metadata says limited, matching Native handle_jpeg.
Native range transitions exposed this distinction; the input frame metadata
remains unchanged. MP4 graph negotiation retains the original source format.

Scoped candidate evidence:2432 fresh full-range matrix comparisons,144 legacy
input comparisons,12 spatial graph comparisons, four24-picture range schedules
in both arithmetic profiles through direct/graph output,264 NodeCLI full-range
comparisons,8 NodeCLI range-transition comparisons and152 workerd/R2 comparisons
plus3 rollback controls. The transition MP4 fixtures disable edit lists; trimming
edits remain unsupported. Final type/static checks and528units passed after the locked-fixture addition.

Canonical Linux audit completed5120 limited/full-range numeric comparisons
(default x86_64 and scalar) with0differences and stable reference binary SHA256.
Native hashes are retained independently of candidate output in a locked fixture,
with source/bundle/input/container provenance and a reproduction tool. The final portable locked-fixture regression passed all5120hashes in2.13s.
Expected combined counts are1099tests (528unit,62integration,307differential,
202Workers),521contracts. These are expected counts, not a completed full report.
No capability is promoted to conformant/bitexact by this candidate. General
SPS/parameter transitions, range/transfer/primaries handling, all edit lists,
production-resource conformance and complete FFmpeg compatibility remain open.


### Full-range and transpose aspect integration; v27 pending

v26 terminated2026-11-22T04:14:05.477Z with stable source/reference snapshots.
Its1091tests had2failures: the same zero-frame setsar/transpose case on Node
and workerd (301/302 differential,200/201 Workers;unit528/integration60 passed).
Common transpose now inverts SAR, but activation actors inverted it a second
time. Removing only the duplicate inversion restores both1134-case corpora.

After terminal v26,28 full-range files and the one-file aspect correction were
integrated with all base/candidate/final hashes checked and originals retained.
Root type/declaration/lint/boundary checks and528units passed10.83s. Root targeted
functional validation passed10files/13tests129.77s, including full/limited matrix
paths,5120locked Linux comparisons, legacy input, range transitions, actual
NodeCLI/workerd output and the1134-case aspect corpus on both runtimes.

A new full report v27 is pending for1099tests/521contracts/14gates. Passing
scoped checks does not certify complete compatibility. MP4 edit-list and
best-effort timestamp work remains isolated and is not included in Root/v27.


### MP4 video-edit continuation integrated after v27

The continuation integrated after v27 adds Native single video edit reconstruction, picture
discard after reference decoding, separate raw/best-effort timestamps and strict
MP4 copy timestamp normalization. The canonical71-input generator includes
version0/version1 pairs, values above2^32 and int64 media-time limits. All71
packet/decode-clock/Node-copy comparisons pass. The prior68-input functional
batch passed816 actual NodeCLI H264 comparisons,544 workerd H264 comparisons
and68 edited workerd copies with rollback/cleanup controls. Final71-input functional checks passed3files/3tests160.91s:852NodeCLI H264,
568workerd H264 and71workerd copies with fault controls. Final type/static
checks and529unit tests passed15.18s after the boundary fix.

Expected combined counts are1106tests (529unit,63integration,310differential,
204Workers),527contracts. Root v27 does not include this continuation. No new
capability conformance is certified; general multiple/empty input edits and
metadata/error/resource/production conformance remain incomplete.


### v27 completed; single-video-edit integration; v28 pending

v27 completed2026-11-22T05:05:47.501Z with1099tests (528unit,62integration,
307differential,202Workers),521contracts and14gates passed. Source and
reference snapshots were stable; compatibilityCertified remained false.

After terminal v27,31 implementation/fixed-fixture/specification files from the
71-input edit continuation were integrated with every base/candidate/final hash
checked. Four historical generated reports were excluded from the candidate so
the verified v27 reports remained intact. Original implementation files and
receipts are retained in ignored promotion evidence.

Root type/declaration/lint/boundary checks and529units passed12.64s. Root
post-integration functional validation passed11files/15tests283.38s, covering
71packet/decode-clock/Node-copy inputs,852actual H264 NodeCLI comparisons,
568H264 workerd comparisons,71edited workerd copies, old MP4 copy/wide cases,
existing framecrc clocks and27original H264 source clocks. Fault and publication
controls remain scoped transactional guarantees, not exact Native error effects.

The new full report v28 is pending for1106tests/527contracts/14gates. Root
includes single unit-rate video edit handling across version0/version1 and the
recorded int64 boundary cases; leading-empty and file-start normalization work
remains in a separate working copy. General multiple-media edits, metadata,
errors, production resources and complete FFmpeg compatibility remain open.


### Isolated leading-empty/file-origin continuation (excluded from v28)

The next continuation adds leading empty video edit delays, true zero-entry and
all-empty lists, default Native recovery of inconsistent entry counts, stream
start ticks and file-wide microsecond origin. Default copy normalization occurs
before mapping and retains relative delays of selected later streams. Positive
mux DTS origins use empty output edits.

The canonical generator freezes78 inputs and36 mappings with Native-only probes
and binary/source manifests. Formal4-file differential validation passed, plus
Node1296, H264 workerd864 and workerd copy72 comparisons with fault controls.
Separate Node72/workerd72 all-empty controls verify failure and preservation of
existing output; exact Native exit183/output truncation is not claimed equivalent.
Final type/declaration/lint/boundary checks and529units passed17.13s after
the last test/contract additions. The five canonical JSON artifacts reproduced
byte-for-byte in a second complete Native generator run.
Expected combined counts are1115tests (529unit,65integration,314differential,
207Workers),536contracts. v28 does not include this continuation. Multiple media
intervals, fractional rates, general metadata/errors and production resources
remain incomplete; no capability is certified conformant or bitexact.

### v28 terminal and integrated MP4 continuation; v29 pending

v28 finished2026-11-22T06:10:03.239Z:1106tests passed (529unit,63integration,
310differential,204Workers),527contracts and14gates. Source/reference snapshots
were stable; compatibilityCertified remains false. Evidence is under
`.build/evidence/2026-11-22T05-17-18.080Z-cf3c1a18-000d-4989-b774-bb636afcc324/`.

After v28 terminated,72 implementation/fixed-oracle/specification/test files
were integrated from four dependent candidates with base/final SHA checks and
backups. Generated compat/reports outputs were excluded. This brings the earlier
leading-empty/file-origin work into Root and adds zero-packet track omission,
multiple video media intervals and default MOV video rate-word handling.

The multiple-edit fixture has60 Native-only inputs with2/3/4/8 entries, separate
no-fill/default packet expectations and fresh Node/R2 copy comparisons. New
H264720Node/480R2 comparisons and2716 previous H264 comparisons passed in the
isolated tree. The96-case rate fixture matches fresh Native Node/R2 copies: the
reference reads and ignores the field in default advanced MOV, rather than
retiming the stream. Both fixtures reproduced all JSON artifacts in a second
complete generator execution. All2499capabilities remain partial/unimplemented
or runtime-blocked;165 are partial and none are certified.

Root type/declaration/lint/boundary checks and533units passed10.83s after
integration. Targeted Root functional verification passed10files/12tests55.80s; full
report v29 is starting for1130tests (533unit,66integration,320differential,
211Workers),546contracts and14gates. These are expected counts, not a completed
combined report. Negative media times other than-1, unrestricted-SPS delay
probing, general rate/strict semantics, metadata/errors and production resource
conformance remain open. The negative-media investigation stays isolated.


### v29 terminal; isolated AAC multiple-interval continuation

Root v29 finished2026-11-22T07:13:17.703Z with1130 tests
(533unit,66integration,320differential,211Workers),546contracts and14gates
passed. Source/reference identities remained stable. This is development
validation, not complete compatibility or production certification.

The dependent AAC multiple-interval continuation adds288 canonical inputs:
12 owned AAC-LC mono/stereo,primed/unprimed sources at8k/44.1k/48k,
short/16copy-loop lengths,ELSTv0/v1 and contiguous/repeated/reversed/middle-empty/
zero-duration/long-unaligned-trim patterns. Native-only fixtures regenerated
independently with all4 JSON artifacts byte-identical. Raw source timing/skip
fields,288 Node copies and288 local workerd/R2 copies match fixed/fresh Native
metadata and payload hashes. Three R2 rollback controls pass. No container-byte
identity is claimed. Four canonical test files passed in81.24s; static gates
and535 unit tests passed. Exact expansion-memory/sample limits and cancellation
are tested independently. General composition offsets/differing clocks,
strict/probing/error semantics and measured production resources remain open.

The new helper reconstructs first-entry skip/preroll and original TTS cursor
semantics with bounded typed arrays. AAC backwards DTS remains in source order
until mux normalization; AVC-specific probing only visits selected video tracks.
This extends demuxer.mov/muxer.mp4 partial status, without claiming AAC decoding.
Combined expected counts after all staged layers:1144 tests,558contracts.
Broader legacy/H264 regression and clean promotion are still pending here.


### AAC continuation integrated; Root validation pending

The isolated legacy regression passed7files11tests in226.16s, including
720 H264 multiple-edit Node comparisons and prior MP4/AAC copy contracts.
After terminal v29 and successful candidate validation,54 unique files from
negative-media-time, AAC leading/partial-priming and AAC multiple-interval
layers were integrated with every base/staged/final SHA verified. Original
Root files are preserved under .build/promotions/pre-mp4-audio-integration.
Generated compat/reports outputs were excluded from all promotions.

Root static/unit and focused functional checks precede full v30. Expected
counts are1144tests (535unit,67integration,327differential,215Workers),
558contracts and14gates. No complete FFmpeg compatibility is certified.


### Isolated AAC signed64 search continuation (excluded from v30)

An additional240-case Native audit found12 source-index mismatches despite all
commands succeeding:ELSTv1 mediaTime INT64_MIN selected the first packet with
skip1024 instead of Native's final packet without skip side data. The pinned
mov_fix_index signed64 mediaTime-minus-timescale search wraps before its clamp
to the first source DTS. The isolated helper now reproduces that arithmetic;
output timestamps remain separately checked for sentinel/overflow.

Deep raw240 comparisons and neighboring96 boundary comparisons pass;240 Node
and local workerd/R2 copies plus3rollback controls pass in62.23s. Canonical
Native-only fixtures expand the boundary positions to192 cases across all12
owned mono/stereo,primed/unprimed,8k/44.1k/48k sources,short/16copy-loop and8
signed64 boundary/control positions. Independent regeneration reproduces all4
JSON artifacts byte-for-byte. Canonical192raw/Node/R2 and existing288raw/Node
regression passed5files5tests75.04s. Allstatic+535units passed15.43s.

This remains a separate candidate while Root v30 is running. Expected combined
counts after promotion:1147tests (535unit,67integration,329differential,
216Workers),561contracts. No full/prod/error/codec-decoding certification.


### Isolated AAC independent clock continuation (excluded from v30)

216 Native copies with independently changed MDHD clocks succeeded while the
previous implementation rejected all216. The continuation separates track ticks
from AAC sample units, floors nominal packet duration into track ticks and
converts final discard padding into samples. Positive STTS sums limit declared
MDHD duration as in pinned mov_read_stts. MOV's initial skip representation is
retained. Audio copy uses ASC output clocks and stateful coarse clock correction
adapted from av_rescale_delta. Source PTS/DTS,duration,timebase and skip-side data
are stamped independently and checked during payload iteration; changed source
duration aborts staging and preserves prior output even when rounding hides it.
Movie timescale uses original input clocks before audio output rescaling.

An authored-clock216-case extension also rescales timing tables. Combined432
Node/workerd-R2 cases plus3fault controls and legacy197/60/66/114copy jobs passed
6files10tests154.85s. The canonical Native-only generator expands to all12 owned
mono/stereo,primed/unprimed8k/44.1k/48k sources,short/long,v0/v1,three edit patterns,
three MDHD clocks and two timing modes:864inputs. An independent full regeneration
reproduced all4 JSON artifacts exactly. Canonical864raw/Node/R2,old288raw/69raw
and2clock guard units passed7files7tests210.05s. Allstatic+537units passed25.74s.
The720-comparison H264 multiple-edit Node regression passed139.30s.

This candidate depends on the separate signed64 boundary candidate and remains
outside the running Root v30. Combined expected counts after promotion:
1152tests (537unit,67integration,331differential,217Workers),564contracts.
AAC decoding, ASC/sample-entry disagreement, composition offsets, strict/probe/
error semantics and measured production resources remain unfinished.


### Isolated AAC sample-entry precedence continuation (excluded from v30)

A60-input Native audit accepted every sample-entry mutation while the previous
candidate rejected12zero-rate entries and exposed24wrong sample rates. Supported
AAC-LC AudioSpecificConfig is now parsed before header validation and supplies
effective codec sample rate/channels despite zero/differing entry words. The
original entry bytes/raw container channels remain accessible. Copy metadata
regenerates rate/channel words from ASC parameters as in mov_write_audio_tag.

The canonical Native-only corpus expands to108inputs from all12 owned sources:
entry rates0/8000/44100/48000/65535 and channels0/1/2/7 with fixed ASC. Raw metadata
and Node/workerd-R2 output header words,stream/packet clocks,skip data and payload
hashes match fresh/frozen Native. Three R2 rollback controls pass. Independent
regeneration reproduced all4JSON artifacts exactly. Canonical3files3tests passed
38.63s,allstatic+537units passed23.43s;prototype5file5test regression40.94s also
covered114existing AAC maps and288interval/192boundary raw comparisons.

This continuation depends on the signed64 boundary and independent-clock layers;
it remains separate from running Root v30. Expected combined counts after all
three layers:1155tests (537unit,67integration,333differential,218Workers),
567contracts. Unsupported ASC types,codec decoding,full/prod/error conformance
remain unfinished. Container-byte identity is not claimed.


### Isolated AAC explicit-frequency continuation (excluded from v30)

Equivalent explicit24-bit AAC-LC frequency syntax succeeded in12 Native copy
commands while the prior candidate accepted only6. A bounded bit reader now
preserves subsequent channel/frame-length bits and rejects truncated explicit
fields. AAC decoding remains unimplemented. Pinned ffprobe fails when opening
its AAC decoder on sampling index15, so its missing packet output was not used
as an oracle. A host-only C packet probe links to fixed reference static
libraries and uses unmodified libavformat discovery/read APIs. Each build checks
commit/headers/binaries/library/compiler/source hashes and12standard ffprobe
cases; the canonical oracle additionally passed1533 standard comparisons.
Production packages never execute/link Native FFmpeg.

384 canonical Native-only inputs cover12owned,60leading,288multiple intervals,
12Nativefaststart and12widev1sources with one extra movie tick beyond2^53.
Descriptor/ancestor sizes and affected chunk offsets are rewritten. The probe
emits all64-bit integers as decimal strings; wide source/copy behavior is
compared without JavaScript precision loss. Source metadata/packet identity,
clocks/skip/payload hashes and Node/workerd-R2 copy ASC/fields/payload hashes
match fresh/frozen Native;3rollback controls pass. Independent-directory
regeneration reproduced all4JSON files exactly using an owned probe-cache copy.
Final canonical4files4tests passed103.49s;allstatic+538units passed19.95s.
Earlier372-case validation passed84.55s before wide/string protocol extension.

This is a separate candidate after the three prepared AAC continuations.
Expected combined counts after promotion:1159tests (538unit,67integration,
335differential,219Workers),570contracts. Other ASC types/PCE/SBR,zero explicit
frequency,codec decoding,full/probe/error/production conformance remain open.


### v30 terminal; four AAC continuations integrated; v31 pending

Root v30 finished2026-11-22T08:35:38.451Z:1144tests (535unit,67integration,
327differential,215Workers),558contracts and14gates passed,with stable source
and reference snapshots. This remains development validation,not complete
FFmpeg compatibility or production certification.

After terminal v30,59 unique files from the signed64 search,independent clocks,
sample-entry precedence and explicit-frequency layers were integrated with all
base/staged/final hashes checked. Original Root files are preserved under
.build/promotions/pre-mp4-aac-continuation. All generated reports/capabilities
were excluded from promotion. Root checks and focused functional tests precede
full v31 for1159tests (538unit,67integration,335differential,219Workers),
570contracts. Zero-frequency fallback work remains in a separate prototype.


Root59-file integration validation passed:allstatic+538units15.97s and focused
9files9tests191.38s. The focused run covers all four new raw/Node-copy families
and the384-case explicit-frequency workerd/R2 path with rollback controls.
Full v31 is starting for1159tests/570contracts/14gates;Root sources are frozen
until terminal validation. The zero-frequency continuation remains isolated.


### Isolated AAC zero-frequency fallback (excluded from v31)

Native accepts explicit-frequency0 metadata and fills sample_rate from MDHD
when its timescale is greater than1.60 canonical inputs cover12owned sources
and nominal/half/double/1000/one clocks. All60 demux metadata/index/payload probes
match,including12unresolved sample_rate0 cases atclock1.48Native/Core copies
succeed and match ASC/stream/packet metadata and payload hashes;the12unresolved
copies fail. Node failures preserve an existing output sentinel;R2 failures
publish nothing.3cancellation/write/planning-budget controls pass.

The60-case Native-only oracle regenerated independently with all4JSON artifacts
byte-identical. Canonical3files3tests passed18.32s;copy controls hardened to
reject process crashes/timeouts then passed2files2tests16.83s. Allstatic and
538units passed17.23s. Earlier5file5test26.62s regression also covered384explicit
raw and108sample-entry copy cases. The separate known-difference record states
Native exit234 versus generic Core1;exact failure protocol is not conformant.
Tests permit future Native-matching codes without locking this difference in.

The implementation retains zero ASC rate until container fallback,permits
unresolved demux metadata without nominal duration filling/divide-by-zero and
rejects unresolved copy plans before writer publication. Fallback clocks beyond
signed sample-rate range remain unsupported. This candidate is isolated while
Root v31 runs. Expected next counts:1162tests (538unit,67integration,
337differential,220Workers),573contracts. Full/error/codec/prod conformance
remains unfinished.


### Isolated Native MP4 exit-status propagation (excluded from v31)

Core ExecResult.exitCode was restricted to0|1. ExecutionError now optionally
carries a validated1..255 status;ordinary failures stay1 and cancellation
retains its existing cancelled result. ExecResult's public TypeScript status
is widened to number. Node CLI already forwards the result,and Workers expose
it in the API response. Tests cover opt-in234,generic/foreign errors,
cancellation and invalid failure status bounds.

MP4 copy validates resolved sample rate on selected audio tracks after codec
resolution and before opening output. Pinned mux.c AVERROR(EINVAL) becomes
process status234;the canonical reason is sample rate not set. Existing12
unresolved-rate cases now match Native exits on Node/workerd-R2. New9two-audio
sources retain a valid later stream and an invalid first stream:54auto/first/
later/both/reverse/duplicate jobs produce27successes and27Native234failures.
All fresh/frozen Native statuses,positive metadata/ASC/payload hashes and
canonical failure reasons match. Failed Node writes preserve sentinel output;
R2 publishes nothing. Three R2 rollback controls pass.

Canonical5files7tests passed25.06s (includes existing60caseNode/R2 and3API units).
Allstatic+541units passed18.36s. An independent generator execution reproduced
all5selected-error JSON artifacts byte-for-byte. The known-difference record
marks the scoped exit mismatch resolved,while full Native log formatting/OS
side-effect protocol remains uncertified. Other Native error mappings are
still open. This candidate follows the prepared zero-frequency layer while
Root v31 runs. Expected combined counts:1167tests (541unit,67integration,
338differential,221Workers),575contracts;full compatibility remains incomplete.

### Isolated conflicting overwrite flags (excluded from v31)

A270case audit across9two-audio inputs,three mappings,existing/absent output
and five overwrite flag combinations found162exit mismatches.108were-y/-n
conflicts:Native returns234 for either order,including unresolved selected audio.
The isolated continuation now checks conflicts after source/selected-codec
validation and before mux audio rate validation. A Native-only108case fixed
corpus reproduces status,canonical reason and output preservation;independent
cwd regeneration reproduced all3JSON artifacts byte-for-byte.

Node108fresh/fixed cases and workerd/R254fixed cases passed (2tests18.40s).
The54selected-stream regression Node/R2 jobs each also passed (2tests15.81s).
All static checks plus541unit tests passed15.02s. Remaining54overwrite-refusal
cases are explicitly tracked in mp4-overwrite-refusal.json:Native returns0 via
AVERROR_EXIT while Edge returns1or234. No full error-protocol claim is made.
The audited270case prototype now has54status mismatches,all the named refusal
cases. This continuation adds2scoped contracts (577total) and2tests;combined
expected1169tests=541unit67integration339differential222Workers. Root v31 is
still running and unchanged;this candidate must follow zero/Native-exit layers
only after authoritative v31 terminal and Root targeted verification.

### Isolated graceful overwrite refusal (excluded from v31)

The prior54refusal exit mismatches are resolved in MP4copy on built-in Node/R2.
A separate Core ExecutionExit represents graceful termination:exit0,no outputs,
code/message diagnostic,no error field. Ordinary failure bounds remain1..255;
foreign zero-status properties are ignored and cancellation remains1/cancelled.
Optional VFS outputExists is a non-mutating writable-path preflight implemented
by Node(realpath/containment) and R2(head/write-mount policy). MP4 checks source/
selected codecs,conflicting flags,output refusal,then mux audio sample rate.
Atomic no-clobber commit is retained to protect output creation races.

The270case audit now has0status mismatches. Native-only108canonical cases
cover54refusals0,18copies0 and36unset-rate234;independent cwd regeneration
reproduced all3JSON artifacts byte-for-byte. Final8files9tests passed42.60s
(newNode/R2108each,2Core graceful/cancellation units,Node preflight race/security,
oldconflict Node108/R254 and selected-error Node/R254each). Four R2 preflight
controls cover cancellation,head failure,read-only mounts and racing objects.
Allstatic+543units passed14.65s;post-adapter-regression edit typecheck/lint passed.
The adapter regression initially exposed an old authored CLI expectation1;
a fresh Native-n command confirms0,and the updated3files102tests pass5.82s.
Existing zero-frequency Node/R2 regression also passed with rollback controls.

Graceful refusal publishes nothing and preserves old output. Native may create
empty OS output on other mux-header failures while Edge atomic abort does not;
that protocol difference remains explicit. Interactive stdin,full stderr,
general formats,custom VFS without outputExists and production Workers remain
unverified. Scoped contracts579;expected combined1174tests=543unit68integration
340differential223Workers. Candidate follows zero/Native-exit/conflict layers;
Rootv31remainsunchanged and must finish before integration.

### Isolated shared single-output overwrite policy (excluded from v31)

The adapter-neutral assertOutputPolicy helper now serves MP4copy,finitePCM,
rawvideo,BMP image2pipe and configured MP4H264 decoding. It checks-y/-n conflict
234 and no-y existing output graceful0 after input/codec initialization and
before output creation. The VFS existence/cancellation/path/mount protection
and atomic no-clobber publication are unchanged.

Native-only13profiles/130cases cover WAVcopy/encode,AIFF,AU,rawPCM,audioframecrc,
rawvideocopy,videoframecrc,BMPcopy/encode/decode,H264rawvideo/framecrc;defaultEOF,
-n,-y and both flag conflicts,existing/absent output.52conflicts234,26refusals0,
52copies0. Fresh/fixed Node and workerd/R2130each passed (plus17frontendunits:
3files19tests19.22s). Independent cwd regenerated all4JSON artifacts identically.
Allstatic+544units passed15.66s;post-PCM-integration edit typecheck/lint passed.
A prior unit treated conflict as unsupported before any input read;that authored
expectation was replaced by an explicit input-failure-before-conflict unit,
matching Native ordering while keeping generic input exit-code mismatch outside
this scoped contract. PCM integration now checks fresh Native refusal0 and old
output preservation. Existing7files27tests (PCM/WAV/AIFF/AU,BMP,rawvideo,H264CLI)
passed52.87s. MP4refusal/conflict4files4tests passed35.79s after helper extraction.

Positive policy cases assert status/output presence;payload compatibility is
covered by existing differential suites,not inferred from these checks.
Full stderr/interactive/OS failure effects,unsupported validation precedence,
complex/multi-output graph publication and production remain unverified.
Custom VFS adapters require outputExists to obtain early refusal semantics.
Added2contracts581total;expected combined1177tests=544unit68integration341diff
224Workers. This follows the four prepared AAC/exit/conflict/refusal layers;
Rootv31must finish before integration. No full compatibility certification.

### Isolated two-output/default and timed overwrite policy (excluded from v31)

Complex/replay planners retain overwrite/noOverwrite policy in their plans;
execution validates source metadata before checking each output. Graceful exits
are propagated without creating writers,queues,replay execution or physical
spools. Explicit timed commands preflight all source metadata and output policy
before creating stores,across pull/activation/read-frames/queued/scheduled/producer.
ComplexVideoFailure preserves explicit failure statuses when cleanup succeeds;
cleanup failure stays1. A focused unit covers status234/foreign-error/cleanup.
The accepted-storage snapshot test now provides valid input metadata so it still
reaches and verifies the original immutable factory after the new preflight.

Native-only7two-output profiles/140cases cover split/raw/crc/mixed,forced replay,
two-input hstack and repeated physical input binding. Five flags/four existence
masks produce56conflicts234,42refusals0,42copies0. Fresh/fixed default Node140,
timedNode840,defaultR2140 and timedR2840 pass;positive raw/framecrc hashes match.
Independent cwd reproduction matched all5JSON artifacts byte-for-byte.
Native leaves an earlier empty OS file in14late-refusal cases;Edge initial
all-output preflight leaves it absent. This explicit known side-effect difference
prevents full protocol certification.

63second-probe cancel/failure/racing-object controls across3graph paths/default+
6schedulers initially exposed early partial publication in the race. OutputGroup
now rechecks all no-clobber destinations immediately before first publication;
observed collisions abort every stage. Per-destination conditional commit and
publishedOutputs/effects remain necessary for later races:cross-object atomic
commit is not claimed. New unit covers no early commit/complete abort on recheck.
Final Node140+840/group tests passed3files9tests26.53s;Workers980+63controls and
failure-status unit passed2files4tests16.38s. Final allstatic+546units passed
15.23s. Existing complex/multi Node launchers and1134timed backend Native cases/
workerd regression passed4files4tests78.05s before the final no-clobber recheck;
these legacy launchers use explicit-y and do not enter the new recheck branch.
Initial scoped tests found and fixed status loss in ComplexVideoFailure and a
fixture optional-method type error;no Native cases were removed or relaxed.

Added4scoped contracts585total. Expected combined1184tests=546unit68integration
343differential227Workers. Full logs,interactive input,generic failure mappings,
custom VFS without outputExists and production Workers remain unverified.
Rootv31remains unchanged until authoritative completion;candidate follows the
five prepared AAC/exit/overwrite continuation layers. Full compatibility open.

### Isolated initial input absence status (excluded from v31)

Core InputNotFoundError independently models initial VFS absence as an
ExecutionError with input-not-found/path/cause and fixed POSIX Native status254
(AVERROR(ENOENT)=-2). Node maps ENOENT during initial realpath/stat;R2 maps null
initial head. Path/mount/security and other errno errors are not misclassified.
After a Node version-bound handle has been accepted,a missing file during the
next range open is NodeInputChangedError;R2 missing/changed generations remain
InputChangedError. Cancellation retains1/cancelled even with the typed error.

Native-only14profiles/280cases cover missing file/parent,5overwrite flags and
existing/absent output;all254precede conflict/refusal and leave outputs intact.
Actual Node280 and timed rawvideo120 across6schedulers,typed-error unit and
post-open Node deletion control passed4files4tests32.27s. Workerd/R2280+120and
post-open R2deletion control passed1file2tests3.39s. No stores/writers are
allocated on initial absence. Independent cwd reproduced all4JSON artifacts
byte-for-byte. Final allstatic+547unit tests passed17.92s. Existing Node/R2
adapter and MP4CLI regressions passed3files102tests6.10s.

Only initial absence is mapped;other errno/malformed-data/failure mappings,
full stderr,Native descriptor side effects,custom VFS and production remain
unverified. The known-difference record carries these limits. Added4contracts
589total;expected combined1190tests=547unit69integration345diff229Workers.
Rootv31has now passed differential and is runningWorkers;Rootunchanged until
terminal. This continuation follows the six prepared overwrite/AAC layers.
Full FFmpeg compatibility remains incomplete.

### Isolated missing local output parent and safe group status (excluded from v31)

OutputParentNotFoundError independently represents missing Node writable parent
as output-parent-not-found/path/cause/254. Node outputExists/openWrite share
parent validation;policy invokes writable-path validation even with-y. Conflicts
remain234 before parent errors;parent errors precede mux AAC sample-rate failure.
OutputGroupError propagates typed status only with successful cleanup and no
opened stages or every stage confirmed aborted. Active writing/prepared,
published/uncertain/committing/cleanup-failed states retain1 and explicit effects.

Native-only26profiles/260cases include14finite/MP4 profiles and12unresolved AAC
rates,two missing parents and5flag modes:156ENOENT254/104conflicts234. Actual
Node fresh/fixed statuses/reasons/no parent creation pass (3files3tests38.91s
including status-safety unit and parent-deletion integration). Independent cwd
reproduced all4JSON artifacts. Focused final safety3files9tests passed768ms;
full allstatic+548units passed15.87s. Existing Node/R2 single/multi-output and
runtime/adapter regressions passed5files106tests22.72s. The final safety tightening
only permits confirmed aborted/no-stage effects;new unit rejects every active
or uncertain state. Existing safe cases/other runtime behavior are unchanged.

R2 keys are not local directories;directory emulation is not claimed. Other
errno/log/OS/production/custom-adapter behavior remains unverified. Added1scoped
contract590total;expected combined1193tests=548unit70integration346diff229Workers.
Dynamic test registration collected exactly these counts and all590contract
names resolve once;this is registration evidence,not a full execution report.
Rootv31stillrunningWorkers,sourceunchanged. Candidate follows seven prepared
layers and must wait for authoritative v31 terminal before Root integration.
Full FFmpeg compatibility remains incomplete.

### Root v31 terminal;128-file exit/I/O continuation integrated

Root v31 session87656 exited0. Evidence
.build/evidence/2026-11-22T08-44-55.541Z-e40e571e-057d-43b0-bfc2-9f960a42f05c/
finished2026-11-22T09:59:11.528Z with1159tests (538unit,67integration,335diff,
219Workers),570contracts and14gates passed. Source/reference stable;full
compatibility remains uncertified. The prior59-file AAC integration receipt
now records this full v31 pass.

After authoritative completion,the eight prepared zero-frequency/Native-exit/
overwrite-conflict/graceful-refusal/shared-policy/multi-output/input-open/
output-open layers were integrated as128unique files. The integration driver
verified terminal report,source/reference identities,all Root-base/staged hashes,
and backups before copying;receipt output-open-integrated.json and backup
pre-output-open-integration retain evidence. Reports/generated capabilities
were excluded. Main Root allstatic+548units pass17.00s;23targeted files/37tests
pass162.48s,covering every new differential/Workers family,the three new Node
adapter integrations and existing PCM/MP4CLI integration behavior.

Current expected full counts1193tests=548unit70integration346diff229Workers,
590contracts. Dynamic registration resolves every named contract once,but is
not a substitute for the next full execution. Full v32 starts after this record;
Root source/docs/tests/tools/compat/config remain frozen until its terminal.

An ignored12case unprivileged permission investigation found8status differences:
Native EACCES243 versus generic1 on unreadable input/unwritable absent-output
parent;Native-y243 versus atomic replacement0 for an unwritable existing file;
and Native-y0 versus staging failure1 for a writable existing file in a
non-writable parent. These findings are recorded in permission-audit/next-work
and are not a promoted compatibility fixture. Permission policy and the Native
in-place/atomic-replacement boundary remain unfinished. Other codec/filter/
protocol/production/FATE/license/resource goals are also incomplete.

### Isolated Node permissions continuation (excluded from v32)

The unprivileged12case audit originally found8status differences. Initial Node
read access is now verified by opening/statting/closing a descriptor before
accepting the version-bound handle. Initial EACCES maps to PermissionDeniedError
with operation/path/cause/243;later revocation remains NodeInputChangedError1.
outputExists accepts optional WriteOptions and snapshots overwrite before I/O.
Existing-output refusal0 precedes access checks;with-y,target W_OK precedes mux
header validation. Staging parent capability is deferred until writer opening,
so12invalid AAC mux-rate cases keep Native234 rather than an early capability
failure. A cleanly aborted/no-stage OutputGroup lets runtime-blocked reasons
through;cleanup failure retains explicit publication/cleanup effects instead.

Native-only26profiles*4permission modes*5flags=520cases. Final comparison records
506exact status matches,14explicit Native in-place success/Core atomic runtime-
blocked1differences,and0unexpected failures. The14cannot atomically replace a
writable existing file inside a non-writable parent under this adapter;caller
permissions are never changed.12same-status AAC failures still have different
OS effects (Native truncates,Edge preserves). Every case is retained;full
permission/protocol conformance is not claimed. Privileged/root execution fails
rather than silently skipping owner-mode checks.

Final canonical4files11tests passed84.63s (520fresh/fixed plus permission/unit/
adapter and output-group controls). Independent cwd reproduced all4Native JSON
artifacts identically. Existing6files116tests passed37.62s. Accepted-policy
snapshot and final output-group/R2 regressions4files13tests passed52.79s.
Final allstatic+550units passed29.59s. Dynamic registration resolves591contracts
once across1197tests=550unit71integration347diff229Workers;registration is not
full execution evidence. The new comparison contract explicitly names506matches
and14retained capability differences. Other errno/ACL/symlink/ownership/log/
descriptor/custom-adapter/R2policy/production behavior remains unverified.

Rootv32 remains frozen and is running differential after integration passed.
This candidate is excluded from that run and must wait for authoritative v32
terminal before integration. Full FFmpeg compatibility remains incomplete.

### Isolated initial intermediate non-directory path component (excluded from v32)

PathNotDirectoryError retains read/write operation,path,cause and fixed POSIX
ENOTDIR236. Node maps initial realpath/probe and initial staging-open failures;
initial staging ENOENT/EACCES also retain typed254/243 without losing cleanup
uncertainty. Once an input version is accepted,a component replaced by a file
remains NodeInputChangedError1. No directory-like path is silently read as media.

Native-only26profiles*2operations*2intermediate-file depths*5flags=520cases:
416ENOTDIR236/104output-conflicts234. Input traversal failure precedes conflict;
output conflict precedes traversal,and invalid AAC mux headers are later. Every
fresh/fixed Native/actual Node status,canonical reason and blocker/output/stage
preservation matches (3files3tests84.05s including typed-status/cancellation unit
and adapter/post-open path replacement/earlier-stage cleanup integration).
Independent cwd reproduced all4Native JSON artifacts. Allstatic+551unit tests
passed19.88s;existing Node/R2/permission regressions6files105tests passed9.83s.

Added1scoped comparison contract592total. Dynamic registration resolves all
592once across1200tests=551unit72integration348diff229Workers;registration is
not full execution evidence. EISDIR/input itself a directory,trailing slash,
other errno/ACL/symlink/ownership/log/descriptor/custom/R2prefix/production
behavior remain unverified. The prior14atomic-permission status differences
remain explicitly open. This continuation follows the frozen Node permission
candidate;Rootv32remains unchanged and running differential. Integration must
wait for authoritative v32 terminal. Full FFmpeg compatibility is incomplete.

### Isolated output directory and significant trailing slash (excluded from v32)

OutputIsDirectoryError carries path/cause and fixed POSIX output EISDIR235.
Existing output directory defaultEOF/-n refuses0 before write validation;-y
fails235 before mux headers. Node preserves trailing separator intent:a regular
input/output file with slash fails236;missing trailing-slash output directory
fails254 rather than creating a regular file. Canonical containment is verified
before trailing-alias metadata inspection. Initial and repeated writer type
validation protect existing directory contents;group cleanup remains explicit.

Native-only26profiles*5directory/slash scenarios*5flags=650cases:104refusals0,
52EISDIR235,78ENOENT254,208ENOTDIR236,208conflicts234. Initial canonical3files3tests
passed83.03s. After containment hardening,final650fresh/fixed/actual Node cases,
status/cancel unit and adapter late-directory/cleanup/root-escape controls pass
3files3tests228.85s under concurrent full-report load. No timeout or expected
status was relaxed. Independent cwd reproduces all4Native JSON artifacts.
Allstatic+552units passed18.31s;Node/R2 regressions6files105tests passed7.98s.

Added1scoped contract593total;expected combined1203tests=552unit73integration
349diff229Workers. Dynamic registration is collected separately;it is not a
full test execution report. Input itself a directory,full symlink/ACL/ownership/
descriptor/OS races/other errors/R2prefix/production remain unverified. Prior
14atomic-permission status differences remain open. Rootv32sourceunchanged and
runningdifferential;this continuation follows the frozen permission/path-type
candidates and must await authoritative v32 terminal before integration.
Full FFmpeg compatibility remains incomplete.


## Initial directory read/discovery continuation

The prepared Node filesystem parent has been extended in an isolated candidate with immutable/bounded execution diagnostics,typed accepted-input read errors,and scoped directory discovery semantics. Fixed Native corpus:1,932cases,all statuses matched;1,600exact-output cases;332known cases/386output differences retained byID. Independent regeneration matched allthreeJSONfiles. Default+six timed graph routes passed2,520executions;automatic/mapped selection passed72timed executions. Ordinary raw multi-input/output normalization now uses the bounded replay engine;duplicate-path generation mutation fails without publication.

Allstatic checks and555unit tests passed. Scoped local workerd regression passed3files/5tests;the new ordinary selection route also passed the1,369simple-video cases and42selector boundaries. Eleven scoped/API contracts are registered (604total;expected1,214tests). Dynamic collection resolved1,214tests and604contracts withzero missing/duplicate names;this is registration evidence,not execution. Parent-filesystem regressions and actual Root full-suite execution are checked separately. This continuation is not a full FFmpeg compatibility or production certification. Headered midstream xerror policy,general read failures,non-bitexact metadata and retained atomic-publication differences remain open;the project-wide codec/filter/protocol/FATE/resource/license goals remain unchanged.


## Root v32 passed; four continuations integrated for v33

Authoritative v32 finished2026-11-22T11:39:11.690Z:1,193tests(548unit/70integration/346differential/229Workers),590contracts and14gates passed;source/reference stable;compatibilityCertified=false. The prior isolated permission,path-type,output-directory and initial-directory-read candidates are now integrated through a guarded77-file copy with backup and unchanged-base/source hashes.

The current Root expects1,214tests(555unit/80integration/350differential/229Workers)and604contracts. Dynamic registration resolves every contract exactlyonce;it does not execute tests. Parent filesystem scoped regression passed1,690Native cases,retaining14atomic-permission status differences;the new1,932-case directory corpus retains332output-difference cases. Root static/targeted validation and full v33 are pending. These records do not claim full FFmpeg conformance or production readiness;all earlier project-wide implementation and audit requirements remain open.


## Isolated reference serialization metadata continuation (excluded from v33)

Rootv33 remains frozen while a dependent candidate addresses default encoder metadata. The explicit low-level metadataProfile selects the fixed Lavf63.1.102 serialization identity;CLI paths select it and suppress metadata for outputbitexact. Low-level defaults retain their prior behavior. BroaderNative comparison exposedandresolved WAV canonical masks,float fmt form,emptyfact sentinel,and H264 outputfflags-bitexact,without removing failures. The336Native-case matrix passes462default/timed executions with complete outputbyte equality;independentNative regeneration matches3JSONfiles.

The original1,932directory corpus is unchanged:allstatusesmatch,exactoutputcasesincrease1600->1632,andknownoutputcases332->300(386->354outputs). The32resolved IDs remain in the known-difference record. Software-line normalization was removed from the existing audio CLI differential. API snapshot/bounded-write/cancel/abort controls pass. Source provenance and LGPL component notice are recorded. Valid headered xerror/midstream/generalmetadata/RIFF/RF64/allplatform/production and broaderproject goals remain incomplete. Full Root integration and validation of this continuation have not occurred.


## Isolated Node launcher build-cache continuation (excluded from v33)

Rootv33integration completed79tests withone60,000ms timeout in the unchanged256-case labelled Node launcher test;the full runnercontinues differential withRootsourcefrozen. This independent candidate caches compiled launcher code by workspace/configuration/toolchain identity with artifact-digest validation and atomic temporary writes. It retains per-invocation arguments,filesystem construction,codec verification and media execution. Missing/retargeted workspace links and unavailable caches use fresh compilation;module evaluation failures are not replayed.

Four independent-process controls pass. The original256case test passes without removing cases,changing Native expectations or raising its60second limit;scoped H264CLI also passes. Alternating12-pair small-command wall-time measurement averaged97.23ms baseline vs67.26ms cached,not production media throughput. Typecheck/lint/boundaries and555unit tests pass. Fourhost-tool contracts bring this independent candidate to608contracts/expected1,218tests(555unit/84integration/350differential/229Workers);it has not been composed with the separate reference-metadata continuation or integrated into Root. Fullgoal/runtime/production/resource/license requirements remain incomplete.


## Composed metadata and launcher candidate; timing failure retained

The two isolated continuations are composed against the frozenv33Rootbase. Shared README/status appendices were merged without losing either history;contracts were merged byID,retaining the updated300-case known-output scope and all distinct additions. Current proposal:1,223tests(558unit/84integration/352differential/229Workers),613contracts. Actual cached Node CLI audit passed all336fixedNative metadata outputs;the same audit is now a persistent differential contract.

Combined static/unit checks passed before that added contract;its typecheck/lint passed afterward. The combined functional run recorded6passes andone69487.55ms timeout in the unchanged256-case labelled test with60000ms limit while multiple heavy suites/audits were concurrent. That failure remains authoritative scoped evidence and has not been waived. No additional heavy tests are started until the ongoing84-test cache-parentintegration finishes. Rootv33also retainsits79pass/1timeout integration result while its remaining suites run. This candidate is not ready for promotion or full conformance.

## Integrated metadata, launcher and WAV remediation; v34 pending

Root v33 is terminal **failed**: 555 unit, 350 differential and 229 Workers
tests passed; integration passed 79/80 with the unchanged 256-case labelled
Node launcher test exceeding its 60-second deadline. Source and Native
reference artifacts remained stable. No timeout or case count was relaxed.

The metadata/cache candidate's separate full integration run passed 78/84.
Its six failures were obsolete minimal WAV header and fixed PCM-offset
expectations in `ffmpeg.test.ts`. That full run remains failed. The repaired
12-test file compares whole WAV output against the pinned Native reference
and retains independent PCM-value, empty-payload, transaction and overwrite
assertions. The labelled case passed at 58.832 seconds in that candidate run,
which is close to the deadline and is not proof of robust timing margin.

The integrated 52-file continuation adds the explicit reference metadata
profile, verified workspace launcher cache, normal-compliance high-mask WAV
serialization and contradictory input-mask fallback. Fixed Native evidence
includes 336 metadata cases, 14 high-mask cases and 72 layout/guessing cases.
All 86 WAV cases also run inside actual workerd with bounded I/O and full
byte/status/diagnostic/output-publication checks. Relevant upstream component
notices are retained; project-wide distribution auditing remains open.

Before Root integration, final production bytes passed all 559 unit tests,
seven metadata regression tests (including all 336 independent Node CLI
comparisons), and 95 targeted Workers tests. The final 1,229 registered tests
and 619 contracts resolve exactly once; registration is not execution.
Root checks and fresh full v34 validation remain required. No full
compatibility, arbitrary-layout, general metadata, production deployment or
release-readiness claim follows from this scoped remediation.

Root targeted validation passed all 559 unit tests and 21 functional checks.
A Node24-only fixture cleanup failure was corrected by unlinking a directory
symlink with `unlinkSync`; the initial failed report remains retained. This
changes test cleanup only. Fresh full v34 execution is the next evidence gate.

## v34 terminal evidence and bounded Native differential execution

The v34 full development validation failed: 1,225/1,229 tests passed, with
three differential timeouts and one Workers signed-video-time timeout. Source
and reference hashes remained stable. Failed evidence is retained.

The resize (18,816 comparisons) and format-negotiation (10,080 comparisons)
matrices now run up to two independent Native CLI processes with immutable
case-local inputs and awaited cancellation/close. Original matrix domains, CLI
arguments, byte assertions and 180/120-second deadlines are preserved. Separate
candidate runs passed in approximately94/40seconds; no full validation pass is
claimed. Four host process-lifecycle unit tests increase expected Root tests
to1,233 (563unit,84integration,356differential,230Workers), retaining619scoped
contracts. Full Root verification remains required.

## Default-layout layer integrated after scoped validation

The current candidate combined all18default-layout files with the bounded
Native oracle changes. Its type/declaration/lint/boundary checks,565unit tests,
9selected differential tests and96Workers tests passed. New contracts retain
all512Native API/CLI outputs and512workerd cases. The prior private queue
failed under Vitest default5seconds because it omitted the preexisting Root
differential default30seconds; that failure remains recorded. The current
validation uses the existing canonical setting, with no package-script changes
or changes to explicit case deadlines.

The18files are now integrated. Expected current Root coverage is1,238tests:
565unit,84integration,358differential,231Workers, with624scoped contracts.
This requires fresh full validation. v34 remains failed; neither scoped passes
nor a1.0release would establish unconditional FFmpeg compatibility.

## Small R2 output staging allocation

Actual workerd observation found that257bytes of output retained a5MiB staging
buffer before this change. Small writes now start at no more than4KiB, bounded
by the output byte limit; growth is limited to min(partBytes,maxOutputBytes).
The configured multipart boundaries, exact bytes and commit behavior remain
the same. Four new workerd cases cover output budgets, small writes, growth
and a5MiB+17byte two-part output. Worker peak memory is not certified.

The subsequent full v35 validation passed1,242tests=565unit+84integration+
358differential+235Workers and624scoped contracts. Prior failed runs remain
failed. The passing run does not isolate staging allocation as the cause of
the previous signed-video-time timeout.


## Parallel codec and CLI integration after v35

The dynamic workflow now adds a bounded libFLAC Wasm decoder, real Core external
memory reservations, FLAC copy to framecrc and decoded PCM/WAV/framecrc through
the public backend and Node launcher. Use `--flac-wasm <module>` before `--`;
the launcher verifies the pinned module size and SHA-256. The reproducible
[codec recipe](../../tools/codecs/flac/README.md) produced two identical fresh builds.

Public parser flags 0, 1, 4096 and 4097 now have finite caller-timestamp traces
against 32 independent Native invocations. An additional 118 Native invocations
characterize header scoring and AVIO schedules; AVIO observations are evidence,
not a claim of public AVIO parity. Actual local R2/workerd checks cover 78 clean
decoder inputs with six lifetime controls and 342 decoded backend outputs with
four transaction controls. Final combined validation is recorded separately
from historical v35.

The earlier statements above that decoder and CLI routes were unimplemented
describe their historical snapshots. Current decoding remains partial: malformed
libFLAC/Native differences, metadata preservation, selected pictures, seeking,
resampling, multiple outputs and additional muxers remain open. See
[the CLI scope](../../compat/behavior-specs/flac-decode-cli/README.md).


## Hermes parallel implementation and integration

A pinned `lingjiuu/hermes-dynamic-workflows` installation now runs four real
implementation children on the existing source, with separate file ownership.
This replaces the earlier external Codex workflow. Its configured ceiling is
32 concurrent children and 1000 cumulative calls; the current implementation
wave used four workers, followed by independent source reviews.

The FLAC decoded backend now streams AIFF/AU using existing bounded muxers.
Finite decoded-frame prefixes and unknown-total inputs use sequential counting
and output passes, with a single real 16 MiB decoder reservation at a time.
Shared stream selection handles ordered, optional and negative maps and exact
picture identities in copy and decode paths; unsupported selected pictures and
decoded duplicate streams fail before publication.

Root combined validation after integration passed 1,404 tests in 21 files,
including 504 expanded Native byte comparisons on actual local R2/workerd and
10 AIFF/AU rollback controls. Four TypeScript configurations, declarations,
ESLint and package boundaries passed. A further 103 stable decoder/Core checks
and 158 existing route/parser/Workers regressions passed separately. These
are scoped checks rather than a new frozen full-project compatibility report;
v35 remains historical. Known malformed libFLAC/Native recovery differences,
seeking, resampling, tag/chapter output, multiple decoded outputs and general
AVIO semantics remain open. No capability was promoted to full conformance.

Independent final source review found two concrete defects: AIFF default
attached-picture selection and missing pre-output WAV size validation. Both
were corrected before the final 1,404-test run. Native pictured-FLAC evidence
shows automatic AIFF selects a PNG encoder (unavailable in the pinned build);
the public backend explicitly rejects selected pictures instead of silently
dropping them. `-vn` and audio-only maps preserve exact Native AIFF bytes. A
shared allocation-free WAV header preflight now uses the same metadata/bitexact
profile as muxing and rejects oversized declared totals before output opens.
This adds a preflight API, not RF64 support.

### Parallel FLAC extension integration (2026-11-23)

A 32-agent Hermes implementation/evidence wave and a 21-agent repair wave
expanded finite FLAC time selection, mono/stereo remix, explicit scalar rate
conversion, bounded audio filters, extended map selection, and native FLAC
packet copy. The first wave had 10 structured reports and 22 timeouts; the
repair wave returned all 21 reports. Agent completion is not conformance proof.
Three scoped final workers repaired configured-empty padding and profile-aware
acceptance. Empty configured `apad` now produces the Native seven silent samples.

Default and scalar Native evidence remain separate, including 24 resample
output differences and explicit fused/separate floating-point arithmetic.
The public local workerd/R2 matrix covers 145 cases: 80 exact outputs, 46
explicit unsupported cases and 19 Native error comparisons, plus six atomic
output fault controls. Five actual Node launcher cases cover the public route.
Native remix evidence now retains all 60 rows and the original partial-run
failure/over-budget history rather than replacing it with a success claim.

Input seeking, selected-picture encoding, chapter serialization, arbitrary
filter/rate placement and rate-changed framecrc packet boundaries remain open.
No full-project capability certification or historical report was promoted.

Final scoped acceptance: **2,865/2,865 tests passed across 71 FLAC and WAV
prevalidation files, zero skips**. All four TypeScript configurations,
declaration generation, ESLint and package boundary checks passed. All nine
new scoped test-contract names resolve to passed assertions in that run.
This is a fresh scoped result, not a replacement full-project report.

### Modal CPU validation (2026-11-23)

Added an ephemeral Modal Linux x64 validation runner with explicit source
allowlists, immutable SHA-256 manifests, 1–16 shards, two CPU cores and 4 GiB
per container, bounded timeouts and zero automatic retries. No credentials or
Darwin binaries are uploaded. Recorded-fixture FLAC unit acceptance and fresh
Linux Native compatibility remain distinct.

Actual cloud runs passed all 213 portable and 724 FLAC unit tests. For the same
FLAC source snapshot, 1 shard took 14.60 seconds and 16 shards took 9.15 seconds
from map submission through result collection (observed peak 12 inputs).
This approximately 1.60× result excludes image build/upload and is not a local
Mac speedup or a full-project performance prediction. Early startup and omitted
helper failures remain recorded separately. See [Modal validation](modal-validation.md).

### Timed FLAC pointwise filters (2026-11-23)

The public FLAC transform now combines scoped time selection with `anull` and
constant `volume` chains when no explicit output rate is supplied. Existing
scalar-rounding requirements and the bounded trim/filter/encode passes remain
in force. Buffering/rate/timestamp-changing filters and timed explicit `-ar`
remain rejected pending Native scheduling work; input seeking is unchanged.

Pinned Native evidence contains 24 unique input-plus-argv scenarios (four input
hashes), retained as 36 actual captures including 12 repeats. Public in-process
and actual Node CLI acceptance match the recorded bytes. Local workerd/R2 without
Node compatibility runs the same captures, five rejection controls and three
atomic-output fault controls. See [timed filter evidence](../../compat/behavior-specs/flac-timed-filters/README.md).

The updated Modal FLAC unit suite passed 741/741 tests across 26 files on Linux
with 16 shards. This tests TypeScript behavior and recorded fixtures, not a fresh
Linux Native oracle or remote Workers execution. The three new test contracts
remain explicitly scoped; no complete feature certification is asserted.

Final scoped regression passed **2,926/2,926 tests across 74 files, zero skips**.
All four TypeScript configurations, declaration generation, ESLint and package
boundary checks passed; all three new contract names resolve to passed
assertions. Modal runner safety tests also passed 13/13. This is scoped FLAC
and WAV prevalidation evidence, not a full-project compatibility certification.

### Native-FLAC copy duration (2026-11-23)

Compressed FLAC copy now supports scoped input/output `-t` and `-to` with zero
or absent seek. It retains whole packets whose Native-style microsecond DTS
estimate precedes the recording-time cutoff. Input/output limits intersect,
`-t` overrides `-to` within its option group, frame limits still apply, and
`-t 0` writes metadata only. Original STREAMINFO/MD5 are retained as in Native;
this does not implement sample-accurate trimming or nonzero seeking.

Native evidence contains 38 command captures (34 successful, four invalid),
plus one recorded source preparation, for 39 Native calls. The 44.1 kHz case
confirms timestamp rounding before comparison at 4,353/4,354/4,355 microseconds.
All 34 successful output byte comparisons pass without decoder configuration
at a 2 MiB budget; one actual Node launcher and actual local R2/workerd pass.
Four invalid Native cases are rejected, but Native exit234 parity is not
claimed. See [copy duration evidence](../../compat/behavior-specs/flac-copy-duration/README.md).

Modal ran the updated FLAC unit suite: 769/769 tests across 27 files passed
with 16 shards (13 observed concurrent inputs). This remains Linux unit and
recorded-fixture validation, not fresh Linux Native or remote Workers proof.

Final scoped regression: **2,999/2,999 tests across 77 files passed, zero skips**.
All four TypeScript configurations, declaration generation, ESLint and package
boundary checks passed. Four new scoped contracts resolve to passed assertions,
and Modal runner safety tests passed 13/13. Historical full-project certification
remains unchanged.

### Time selection with scalar FLAC resampling (2026-11-23)

The decoded FLAC transform now permits scoped time selection with an explicit
output sample rate and optional `anull`/constant `volume`. Input `-t`/`-to`
truncate source audio before FIR, while output `-ss`/`-t`/`-to` select samples
after FIR at the destination rate. This preserves the preceding input history
for output seeking and uses actual resampler EOF rather than scaling declared
STREAMINFO totals. The existing same-rate route is preserved.

32 unique pinned scalar Native commands cover 16/24-bit known/unknown totals,
11025/48000/4000 Hz, raw/WAV/AIFF/AU, short input, zero duration, past/near EOF,
independent limits and volume. All exact public and actual Node CLI comparisons
pass. Actual local R2/workerd without Node compatibility covers all32 rows,
five unsupported-policy controls and three atomic-output fault controls.
See [time/rate evidence](../../compat/behavior-specs/flac-timed-rate/README.md).

Changing-rate framecrc and decoded frame limits, buffering/rate-changing filter
placement, timed aformat, negative output timestamps and nonzero input seeking
remain open. The scalar profile is explicit; generic CPU arithmetic and full
architecture conformance are not certified by this scope.

Final scoped regression passed **3,052/3,052 tests across 80 files, zero skips**.
All four TypeScript configurations, declaration generation, ESLint and package
boundary checks passed, with all four new scoped contract assertions resolved.
Modal passed 782/782 tests across 28 unit files in16 shards; runner safety tests
passed13/13. Historical full-project certification remains unchanged.

### Timed FLAC sample-format constraints (2026-11-23)

Time selection now combines with singleton `aformat=sample_fmts=…`, `anull`
and constant `volume` at unchanged output rates. The existing format converter
and Core reservations cover all10 packed/planar u8, s16, s32, flt and dbl
representations. Exact planar packing and pre-source memory admission are
covered by new unit cases. Changed-rate aformat and general format/rate/layout
negotiation remain open.

36 Native command captures retain32 supported sample-format scenarios and four
Native-positive rate/layout-constraint gaps. The supported outputs match in
public integration, actual Node CLI and actual local R2/workerd without Node
compatibility. Four unsupported controls and three atomic-output fault controls
preserve previous output. The four retained constraint gaps are not counted as
byte compatibility successes. See [aformat evidence](../../compat/behavior-specs/flac-timed-aformat/README.md).

Modal passed802/802 tests across29 unit files in16 shards. This is recorded-
fixture/unit validation on Linux, not fresh Linux Native or remote Workers
certification. Existing full-project compatibility status remains unchanged.

Final scoped regression passed **3,115/3,115 tests across83 files, zero skips**.
All four TypeScript configurations, declaration generation, ESLint and package
boundary checks passed after fixing a test-only implicit-any error. All four
new scoped contract assertions resolve to passed tests; Modal runner safety
tests passed13/13. Historical full-project certification remains unchanged.


### FLAC singleton aformat with scalar rate conversion (2026-11-23)

Singleton sample-format constraints now combine with output `-ar`, optional
constant volume and scoped input/output time windows. Automatic FIR insertion
follows the negotiated format boundary. For boundary-zero conversion Native
places rate conversion before input recording-time trim; other boundaries
retain source-rate input trim. Downstream sample width bounds FIR chunks while
preserving source frame admission and separate Core filter/FIR reservations.

36 independent pinned scalar Native captures include32 exact public Node and
actual local R2/workerd outputs and four explicit double-output precision gaps.
The latter reject before publication; their cause is not conclusively proven.
AU integer output retaining a double intermediate remains covered by exact
comparisons. General format/rate/layout negotiation, mixed channel conversion,
changing-rate framecrc/frame limits and buffered-filter scheduling remain open.
See [evidence](../../compat/behavior-specs/flac-aformat-rate/README.md).

Modal passed815/815 tests in30 unit files across16 shards (actual peak10
containers). This is Linux unit/recorded-fixture evidence, not fresh Linux
Native or remote Workers certification. Runner safety tests passed13/13.

Final scoped regression passed **3,172/3,172 tests across86 files, zero skips**.
All four TypeScript configurations, declarations, ESLint and package boundary
checks passed. Four new scoped contracts resolve to passed assertions. Existing
full-project capability/conformance certification remains unchanged.


### FLAC identity rate/layout aformat constraints (2026-11-23)

Singleton `sample_rates`/`r` and canonical mono/stereo `channel_layouts`/`cl`
constraints now pass when they agree with the current filter-stage metadata.
They combine with sample-format constraints, volume and time windows. No implicit
rate or channel conversion is invented. Metadata validation follows asetrate and
inserted FIR boundaries, checks actual frames as well as configured input, and
rejects unconfigured empty constrained streams. Generic PCM preflight runs before
opening output even when zero-duration output never pulls the encoder generator.

The existing timed-aformat36 rows now all match public Node and actual local
R2/workerd byte for byte; the four former identity-constraint gaps have been
closed. A new corpus adds16 independent pinned Native captures covering pure
constraints, aliases, optional formats, volume order and zero output duration.
Actual CLI, four mismatch-policy controls and three R2 output-fault controls pass;
Native error text/status parity is not claimed. General candidate negotiation,
implicit conversion and the preceding double-output precision gaps remain open.
See [identity-constraint evidence](../../compat/behavior-specs/flac-aformat-constraints/README.md).

Modal passed839/839 FLAC unit tests in31 files and213/213 portable tests in51
files, each in8 shards. All four TypeScript configurations, declarations, ESLint
and package boundary checks passed; Modal runner safety tests passed13/13.

Expanded regression covered **3,774 tests across223 files**, including every unit
file plus scoped FLAC integration/Workers and PCM constraint preflight. The first
run passed3,771 and exposed three old WAV syntax tests whose undeclared inputs
were now magic-probed before WAV validation. Those test fixtures now explicitly
declare `-f wav`; the complete affected17-test file passes after the correction.
Combined final assertion coverage is3,774/3,774, zero skips. Both original failure
and focused rerun reports are retained in `.build/flac-aformat-constraints`;
this is not represented as one clean full-suite invocation. Final test typecheck
and targeted lint pass. Four new scoped contracts resolve to passed assertions.
Historical full-project capability/conformance certification remains unchanged.


### Timed FLAC finite padding and reframing (2026-11-24)

Time selection now combines with finite `apad` and `asetnsamples` at unchanged
sample rates, optionally with sample-format constraints and constant volume.
Input recording time trims before user buffering; output seek/duration selects
the filtered stream afterward, including silence beyond the original decoded
EOF. Output trimming preserves post-filter frame boundaries, and frame limits
apply to those surviving frames. The existing sequential prepass and Core
filter/trim reservations remain in use; media is not buffered as a whole.

24 independent pinned scalar Native captures match public Node, actual CLI
and actual local R2/workerd bytes across raw/WAV/AIFF/AU/framecrc. Four negative
scheduling controls and three sentinel-preserving output-fault controls pass.
The framecrc cases prove23/64/64/10 surviving sample boundaries and the two-frame
limit23/64. Rate-changing buffering, timed asetrate, nonzero input demux seeking
and general scheduling remain open. See [buffering evidence](../../compat/behavior-specs/flac-timed-buffered/README.md).

A separate metadata preflight closes a zero-frame constraint hole: counting
with `-frames:a 0` bypasses the transformation iterator, but aformat rate/layout
constraints are now checked from prepared stream metadata before counting or
opening output. Identity-constraint acceptance retains16 Native exact cases
and now eight mismatch-policy controls, including zero duration and zero frames.
These policy controls do not certify Native diagnostic/exit-status parity.

Modal passed842/842 tests across32 FLAC unit files in16 shards (actual peak5
containers). All four TypeScript configurations, declarations, ESLint and
package boundary checks passed. Runner safety tests passed13/13. Historical
full-project capability/conformance certification remains unchanged.

Final scoped regression passed **3,293/3,293 tests across95 files, zero skips**
in one clean invocation. Five new scoped contracts resolve to passed assertions.
The source/reference hashes and raw reports are retained in
`.build/flac-timed-buffered/receipt.json`. This scoped run does not replace the
historical full-project conformance report.


### Persistent whole-command media jobs (2026-11-24)

Design section11 now has a first persistent execution path in
`@edge-ffmpeg/runtime-cloudflare/jobs`, with a Workers-only Durable Object export.
One SQLite DO owns one job. Immutable specifications pin arguments, object
ETag/version/size, implementation version, a single-command WorkUnit descriptor
hash, resource budget and retry/lease policy. SQL state and alarm updates share
one transaction. A repeating outbox sends Queue messages after commit and
recovers failed dispatch or expired execution. Namespace/job-ID mismatches and
changed resubmission specifications are rejected.

Generation/token/expiry leases fence heartbeat, cancellation, failure and
finalization. Actual FFmpeg execution reads only declared pinned sources and
writes immutable attempt objects. A succeeded DO record atomically publishes
artifact pointers; stale attempts cannot replace a shared R2 output. Lost success
responses reconcile persisted terminal state without deleting the winner's
objects or rerunning its command. A conservative multipart/read/write envelope
is subtracted before the remaining resident budget is supplied to FFmpeg.

Actual local workerd tests use SQLite, Queue and R2 bindings without Node
compatibility. They cover duplicate requests, real Queue delivery, full runtime
restarts with running/completed states, lease expiry, stale finalization,
cancellation during backend execution, success response loss, changed content
and same-content replacement versions, implementation pins and retry exhaustion.
PCM/volume/WAV output matches independent single-Worker execution byte for byte;
this is orchestration parity rather than fresh Native media conformance.
See [durable job usage and boundaries](durable-media-jobs.md).

Final regression passed **1,952/1,952 tests across181 files, zero skips**, including
all unit tests and the durable-job, R2 buffer and existing runtime Worker suites.
The initial run's one stale fault-injection expectation is retained alongside
the final clean run: the API now returns reconciled terminal state after a lost
success reply rather than propagating the injected error. A fixture-only triple
slash lint failure was corrected with explicit generated-Env inclusion in the
Workers TypeScript configuration. All four type configurations, declarations,
ESLint and package boundaries then passed. Four new runtime contracts resolve
to passed assertions. Modal passed244/244 portable tests across53 files in16
shards (actual peak9 containers), with14/14 runner safety tests.

This is whole-command replay, not codec/filter/Wasm state checkpointing. Workflows,
media-graph partitioning, merge workers, serialized component continuation and
automated orphan-artifact garbage collection remain open. Private attempt objects
are retained when outcome is uncertain. The coordinator and bucket bindings are
trusted application capabilities; the test control API is not a production
service. No deployment, remote CPU/peak-memory certification or broad capability
promotion was performed. Historical full-project conformance remains unchanged.

### Explicit whole-command Workflows DAG (2026-11-24)

Cloudflare Workflows now orchestrates an explicit bounded DAG of whole-command
jobs. Independent ready nodes are submitted up to the configured active limit;
dependencies inherit exact committed parent generations. Durable steps derive,
submit, poll and finalize. Atomic expected-spec cancellation creates tombstones
for delayed submissions and preserves conflicting existing jobs. All-success
results publish an immutable, content-verified R2 manifest. See
[usage and limitations](media-workflows.md).

Actual Workflows/Queue/SQLite/R2 acceptance passes a three-node dependency graph,
byte equality with independent execution, serial/parallel readiness bounds,
completed-result restart persistence, queued-peer failure cancellation, late
submission fencing and foreign-spec preservation. Local CPU overlap and automatic
in-flight Workflow resumption across a runtime restart remain unverified.
External platform termination does not automatically cascade to child jobs.

Regression passed **1,990/1,990 tests across185 files, zero skips**. Four TypeScript
configurations, declarations, ESLint and package boundaries passed. Three scoped
contracts resolve to passing assertions. Modal passed **269/269 tests across55
portable files**,16 shards, actual peak15 concurrent inputs; runner safety passed
14/14. Reports and source/reference hashes are retained in
`.build/media-workflow/receipt.json`. Modal covers the portable planner/builder,
not the actual Workers integration. Automatic media-graph partitioning, stream
merge and serialized component checkpoints remain open. No deployment or broad
Native/capability certification was performed.

### Workflow-wide explicit cancellation (2026-11-24)

`cancelMediaWorkflow(originalSpec, {workflow, JOBS})` now persists a per-node
ownership fence before terminating the platform instance. Fences cover future
nodes before parent artifact pins exist, survive full runtime restart and cancel
late matching submissions without claiming them. Existing successful results are
preserved. Optional workflow ownership participates in immutable job identity;
legacy standalone specifications remain unchanged. Older unowned workflow jobs
require their original cancellation path and cannot silently acquire ownership.

All node fences must confirm before platform termination. Any conflict/provider
failure reports bounded partial details, retains confirmed fences and leaves
termination unattempted. Retry is idempotent. Lost or redundant termination
responses reconcile authoritative terminal status. Direct platform termination
still does not imply child cancellation. Application callers must retain the
original trusted submitted spec; this capability API is not authorization.

Actual Workflows/Queue/SQLite/R2 acceptance stops a manually claimed running root
and a queued peer, fences an unsubmitted dependent, repeats cancellation, restarts
the entire runtime and blocks a prepared late child submission. It also preserves
a foreign ownership graph and reports incomplete cancellation. A prepared late
parent artifact simulates an in-flight delivery; it is not a claim that the
cancelled parent successfully committed. Existing cancellation-during-backend
coverage remains in the durable-job suite. Automatic in-flight Workflow restart
resumption and simultaneous local CPU execution remain unverified.

Regression passed **2,010/2,010 tests across187 files, zero skips**; four TypeScript
configurations, declarations, ESLint and package boundaries passed. Three new
scoped contracts resolve to passing assertions. Modal passed **289/289 tests
across57 portable files**,16 shards, actual peak7 concurrent inputs. Runner safety
passed14/14. Source/reference hashes and raw reports are retained in
`.build/workflow-cancellation/receipt.json`. No deployment or new Native media
compatibility certification was performed; the full architecture remains open.

### Independent graph partition planning and Workflow adapter (2026-11-24)

Core now discovers weakly connected components automatically and creates immutable
independent WorkUnits with canonical membership identities. Each unit receives
its own Worker memory/packet-slot admission check; aggregate resource estimates
are separate. All node execution traits and required budget fields are validated.
CPU uncertainty propagates explicitly and unsafe aggregate sums are rejected.
Connected stateful/temporal paths and shared-source branches remain indivisible,
even if checkpoint metadata is declared. No compatibility status is promoted.

The Cloudflare adapter maps discovered components into persistent command jobs
using application-supplied whole-command lowering. It rejects cross-component
artifact dependencies and more than16 jobs, pins shared objects once, and hashes
canonical source graph provenance into Workflow identity. Metadata, commands,
budgets and scheduling are captured before asynchronous hashing/input pinning.
Actual local Workflows/Queue/SQLite/R2 acceptance runs two automatically discovered
components and compares their WAV bytes with independent execution. Generic
operator-to-command compilation, connected-stream partitioning, state checkpoint
serialization and media joins remain open. See
[independent graph planning](independent-graph-planning.md).

Regression passed **2,056/2,056 tests across189 files, zero skips**. All four
TypeScript configurations, declarations, ESLint and package boundaries passed.
Three new scoped contracts resolve to passed assertions. Modal passed
**343/343 tests across60 portable files**,16 shards, actual peak16 concurrent
inputs; runner safety passed14/14. Initial focused Worker failures were caused
by a missing fixture import and are retained alongside the corrected clean run.
Source/reference hashes and raw evidence are retained in
`.build/independent-graph/receipt.json`. No deployment, simultaneous CPU execution
certification or new Native media conformance promotion was performed.

### Typed linear graph-to-command lowering (2026-11-24)

`lowerIndependentCommand` converts typed source/input-options/filter/output-options/
sink bindings into complete CLI commands. It follows the actual linear graph,
retains filter order and file option scope, and rejects missing/extra bindings,
branches, joins, ambiguous stage order, URL injection, global escapes and raw
filter/map overrides. Supported audio/video frame ports must match their filter
bindings. Option fragments and final command size are bounded; output declarations
and arguments are frozen. Registry metadata is not a generic executable codec
registry, and binding text is not inferred from feature names.

`buildCommandGraphMediaWorkflowSpec` now connects independent graph discovery,
this lowerer and persistent Workflow jobs without an application command callback.
Bindings are captured before asynchronous hashing/pinning, and lowered commands
and source provenance participate in immutable Workflow identity. Actual local
Workflows/Queue/SQLite/R2 acceptance runs two six-stage graphs and verifies exact
arguments and committed WAV bytes against the existing explicit command path.
Two additional pinned Native FFmpeg comparisons verify raw PCM byte identity for
one and two ordered volume filters over odd and extreme signed samples. This is
scoped lowering evidence, not broad capability promotion. See
[typed lowering](command-graph-lowering.md).

Regression passed **2,125/2,125 tests across192 files, zero skips**, including all
unit tests, both new Native cases and persistent Worker suites. Four TypeScript
configurations, declarations, ESLint and package boundaries passed. Four scoped
contracts resolve to passing assertions. Modal passed **410/410 tests across62
portable files**,16 shards, actual peak15 concurrent inputs; runner safety
passed14/14. Source/reference hashes and raw reports are retained in
`.build/command-graph/receipt.json`. Connected-stream partitioning, multiple-input
filter graphs, codec/filter/Wasm state serialization and general graph lowering
remain open. No deployment or whole-project conformance promotion was performed.

### Typed complex video graph lowering (2026-11-24)

`lowerComplexVideoCommand` now lowers explicit video filter DAGs, including
split/branches/joins and multiple file outputs, into stable generated link labels
and per-output maps. Declared filter pad order is preserved independently of graph
node/edge declaration order. Source/demux/decode prefixes and encode/mux/sink
suffixes stay unary and exclusively owned. All nodes and pads must be accounted
for; mixed/audio filters, shared nonfilter stages, implicit fanout, file collisions
and option scope overrides are rejected. Filter graph size and argument tokens
are bounded. Existing linear lowering reuses internal scope helpers unchanged.

`buildComplexVideoGraphMediaWorkflowSpec` connects these graphs to persistent
jobs without an application argv callback. Each connected filter graph remains
one job. Two scoped Native cases compare exact raw gray output for three finite
frames: split → hflip/null → ordered hstack, and split → two encoder/mux/sink
outputs. An independent pixel-order assertion checks stack pad semantics.
Actual local Workflows/Queue/SQLite/R2 runs both graphs and checks Native bytes,
manifest declarations and artifact ETag/version generations. Source helper code
is portable and Worker bundles contain no Node built-ins. See
[complex video lowering](complex-command-graph-lowering.md).

Regression passed **2,165/2,165 tests across196 files, zero skips**, including all
unit tests, prior and new Native lowering cases, and persistent Worker suites.
All four TypeScript configurations, declarations, ESLint and package boundaries
passed. An initial test TypeScript check caught a missing fixture import; the
corrected clean check is retained. Four scoped contracts resolve to passing
assertions. Modal final validation passed **447/447 tests across64 portable
files**,16 shards, actual peak16 concurrent inputs; the earlier445-test snapshot
is retained before two additional topology assertions were added. Runner safety
passed14/14. Source/reference hashes and raw reports are retained in
`.build/complex-command-graph/receipt.json`.

This does not split a connected graph across Workers or implement serialized
codec/filter/Wasm continuation. Audio complex graph execution and generic graph
lowering remain open. Structural multi-source lowering has unit coverage; new
Native and Workflow oracle cases cover one source only. No deployment,
simultaneous CPU execution certification or whole-project conformance promotion
was performed.

### Serializable audio FIFO state and execution checkpoint envelope (2026-11-24)

`reframeAudio` now uses an explicit stateful packed/planar FIFO with push,
finish, snapshot and disposal APIs. Its pending plane bytes, configured format,
received/emitted counters, bigint timestamp origin and terminal state have a
versioned bounded binary codec. Restore validates format, configuration, payload
length and counter relationships before allocating FIFO storage. Snapshots do
not alias mutable state. Processing must finish one input-frame transition before
snapshotting; early iterator abandonment poisons it. Completed old iterators are
inert and cannot clear a newer input transition's busy state. Native generator
disposal compatibility is retained without importing Node-specific APIs.

Core's execution checkpoint envelope binds version, job/WorkUnit, graph hash,
pinned input fingerprint, implementation version, state references and bigint
committed position. Identity mismatch is rejected before component restoration.
It is metadata validation, not authentication, object fetching or an atomic
output/state transaction. See [audio FIFO checkpoints](reframe-checkpoints.md).

New unit coverage spans all ten packed/planar widths with padded/unpadded output,
partial and aligned-empty FIFO boundaries, positive/negative bigint or unknown
PTS, finished snapshots, corruption, allocation limits and iterator ownership.
Actual local workerd acceptance commits the first three samples from four
received stereo s16p samples, persists the remaining sample and envelope to R2,
disposes the whole runtime and restores into a fresh Worker. For both pad modes,
assembled PCM bytes and PTS match uninterrupted execution and pinned Native
FFmpeg. State digest, envelope identity and committed prefix-size checks occur
before restoration. Tampered state, cancellation and insufficient budgets do not
publish resumed output.

Regression passed **2,261/2,261 tests across199 files, zero skips**. A separate
unchanged-media regression passed **34/34 tests across4 files** covering Native
asetnsamples/planar reframing and timed FLAC Node/Worker paths. Four TypeScript
configurations, declarations, ESLint and package boundaries passed after correcting
Workers TextDecoder option typing and preserving native generator disposal types.
Three scoped contracts resolve to passed assertions. Modal passed **542/542 tests
across66 portable files**,16 shards, actual peak11 concurrent inputs; runner safety
passed14/14. Source/reference hashes and raw reports are retained in
`.build/reframe-checkpoint/receipt.json`.

This is the first verified serializable filter component, not serialized generic
FFmpeg/Wasm execution. Job/Workflow runners still replay complete commands;
checkpoint coordination with media output commits, codecs/muxers, resampler
history and remaining filter/queue states is open. No production deployment,
whole-project conformance promotion or complete pipeline continuation is claimed.

### Lease-fenced checkpoint/output publication journal (2026-11-24)

A separate SQLite `MediaCheckpointCoordinator` now publishes a verified component
state pointer, output chunk pointer and input/output progress in one transaction.
Identity binds job/WorkUnit, graph hash, pinned inputs and implementation version;
every descriptor repeats that full identity to reject mismatched preparation.
Lease generations/tokens fence new commits, while an exact original-committer
retry returns current state even after expiry, a newer owner or later revision.
It does not rewind output or duplicate a published chunk. Cancellation and finish
fence future work. Revisions, object ownership prefixes, monotonic input position,
output byte deltas and metadata bounds are validated atomically.

R2 helpers stage immutable attempt-local state/output objects with conditional
puts, reconcile lost acknowledgements by exact size/digest, and reload committed
objects by ETag/version/size/SHA-256. Preparation does not publish progress.
State-only buffering and terminal flush transitions are supported. Application
code must use the committed journal as its output list and verify component
counters against journal positions. See
[coordinated checkpoint journal](media-checkpoint-journal.md).

Actual local workerd/SQLite/R2 acceptance observes revision0 after preparation,
commits with an injected lost HTTP acknowledgement and confirms one history entry
after retry. A completely fresh runtime recovers the lease and resumes from the
committed FIFO/input position. For stereo s16p8kHz n3 p0/p1, assembled PCM and actual
emitted PTS match pinned Native FFmpeg. Tests cover stale owners, old revision
replay after final publication, and independent state/output tampering. The
fixture also checks FIFO received/emitted counters against journal positions.
This certifies atomic SQLite pointer publication, not a cross-service R2 commit.

Regression passed **2,306/2,306 tests across202 files, zero skips**. Four TypeScript
configurations, declarations, ESLint and package boundaries passed. Four new
scoped contracts resolve to passed assertions. Modal passed **586/586 tests
across68 portable files**,16 shards, actual peak13 concurrent inputs; runner safety
passed14/14. Generated Workers bindings include the new SQLite coordinator.
Source/reference hashes and raw reports are retained in
`.build/media-checkpoint/receipt.json`.

This API is driven by the application; automatic queue/Workflow scheduling inside
a complete pipeline, final container assembly, codec/Wasm/muxer continuation and
orphan collection remain open. Prepared objects from stale/uncertain attempts are
retained. No production deployment, total CPU/heap certification or whole-project
conformance promotion was performed.

### Checkpoint final assembly, apad state and automatic unit runner (2026-11-24)

`finalizeMediaCheckpointOutput` now assembles a finished journal into one
destination opened through an atomic `VirtualFileSystem` writer such as staged R2
output. Before opening anything it snapshots the status and requires a finished
phase without a lease, contiguous revisions with the journal identity, exactly
one terminal commit, monotonic positions, per-revision output sizes equal to the
output deltas and object keys beneath this journal's attempt prefixes. Only
committed output objects are read, one at a time through the same ETag, version,
size and SHA-256 pins as `loadMediaCheckpointOutput`, and written in bounded
slices. Any failure before commit aborts the writer once, so the destination is
never published. This is byte concatenation; see
[final byte assembly](media-checkpoint-journal.md#final-byte-assembly).

`createAudioPadState` exposes the finite apad state machine that `padAudio` and
the CLI `apad` step now run through, with bounded tail steps (`finish(maxPackets)`)
and a strict versioned snapshot of configuration, stream format, origin,
received/emitted counters and end-of-input status. apad retains no input payload,
so there is no sample buffer to save. Restore checks configuration, the empty-input
descriptor, packet alignment, the remaining packet budget and terminal status
before any output. See [apad checkpoints](pad-checkpoints.md).

`runCheckpointedMediaUnit` drives one component WorkUnit through the journal:
claim, restore the latest committed state through its pins, process bounded
units, prepare, commit and finalize, returning `yielded` at a unit budget. A lost
commit reply is replayed with the identical descriptor and original lease, and
later failures are confirmed through `status()`. Cancellation, lease loss and
abort end the invocation without committing stale work, and in-memory state never
carries progress between invocations. See [automatic runner](media-checkpoint-runner.md).

Local workerd acceptance resumes apad from R2 in a fresh runtime for five option
sets over 8 stereo s16p samples at 8 kHz; raw PCM and packet sizes/PTS match
uninterrupted execution and the pinned Native
`aformat=s16p,asetnsamples=n=3:p=0,apad=...,asetpts=PTS+123` output and framecrc.
The runner acceptance drives the audio FIFO across destroyed runtimes, a dropped
commit reply and a crash after commit with the real SQLite coordinator and R2; the
published object matches pinned Native FFmpeg byte for byte (92 bytes unpadded,
96 bytes padded) and the committed frame sizes and PTS equal Native framecrc. The
journal acceptance additionally publishes both padding variants and verifies a
replay and a tampered chunk. These items were reviewed when implemented but not
recorded here until the full validation below.

### Checkpointed resampler state and strict component codecs (2026-11-24)

`createAudioResampleState` exposes the default Kaiser FIR as an explicit state
object; `resampleAudio` now drives it, so continuous and restored execution share
one implementation. A snapshot carries the output rate, requested precision, the
plan (rates, channels, FIR precision, taps, phases, interpolation), frame format,
PTS origin, received/emitted counters, end-of-input and terminal flags, at most
`taps + 1` history samples and any pending partial frame. Coefficients are
rebuilt from the plan on restore, and phase, position and interpolation fraction
are recomputed exactly from the `emitted` counter. A drift guard pins
`resampleAudio` output to SHA-256 digests recorded from the replaced
implementation for 11 rate pairs. See [resampler checkpoints](resample-checkpoints.md).

The resampler, apad and audio FIFO decoders now accept only the exact canonical
version 1 bytes their serializers produce. Unknown or missing fields at any
level, whitespace, reordering, escapes, number re-spellings, duplicate keys, a
BOM, truncation and trailing bytes are rejected; other versions are rejected,
never migrated. Snapshot counters above `2^63 - 1` and origins outside signed64
now fail at serialize, decode and restore, while live processing still accepts any
bigint origin. apad also range-checks its empty-input descriptor at configuration.
Allocation limits are checked before payload copies or coefficient rebuilds.
Decoders validate structure, not authenticity, so stored state needs a digest or
version pin.

Differential tests against the pinned build hand state off at every input and EOF
tail boundary and once fully chained. The forced signed16 FIR
(`aresample=<rate>:tsf=s16p`) is byte-exact for 24 fixtures (six rate pairs
including both interpolating ratios, mono/stereo, packed/planar). The default
`aresample=<rate>` is byte-exact only for 18 recorded fixtures (8 float, 10 s16
through the float FIR), not as a general float claim. Double and interpolating
float are byte-identical to uninterrupted runs but agree with Native only within
the recorded 2e-12 and 1e-6 tolerances. Local workerd restores forced-s16 states
saved mid-stream, after the last input and after one tail step for four rate
pairs in a fresh runtime, matching Native PCM byte for byte.

### Checkpointed WAV mux and verified no-clobber final assembly (2026-11-24)

`createWavMuxState` writes the Native-profile WAV header with the placeholder
sizes Native writes before its trailer, passes packet bytes through, and on finish
returns the odd-data pad byte plus at most three 4-byte patches (RIFF size, `fact`
count for non-PCM tags, data size). Its strict canonical snapshot is at most 1 KiB.
The EdgeFFmpeg default profile, other codecs and RF64-sized streams fail
explicitly; the finite `muxWav` now shares its layout, header and timing code.
See [WAV mux checkpoints](wav-mux-checkpoints.md).

Finalization gained an optional `patches` callback that receives only the
pinned terminal committed state; patches are validated (count, bytes, range,
overlap) before any destination is probed and applied while chunks stream.
Without `overwrite`, an existing destination is verified by size and streamed
SHA-256: identical content returns `existing: true` and different content throws
`MediaCheckpointOutputConflictError`, neither opening a writer. A destination that
appears before commit, or a lost conditional put, aborts staging once and is then
verified. Only `R2CommitUncertainError` and errors marked `published: true` (such
as a cleanup failure after publication) keep staging; every other commit failure
discards staging before reprobing.
`maxReadBytes` is an upper bound that halves after an adapter `RangeError`.

In this item, Native parity of the continuation is local workerd evidence for three
8 kHz cases only (stereo s16 `p=1` with LIST/INFO, mono u8 `p=0` `-bitexact` with a
pad byte, stereo f32 `p=1` with `fact`), each 23 samples in three invocations across
destroyed runtimes; the pipeline item below adds its `pcm_s16le`/`pcm_f32le`/`pcm_f64le`
outputs. The same test covers conflicts, appear races with the multipart upload
aborted, lost-put races with the completed staging object deleted, a staging
integrity failure, an uncertain publish kept for recovery, patch rejection,
overwrite and tampered terminal state. The 768-combination unit test (one test
looping over the combinations) shows equivalence to the finite `muxWav`, not to
Native.

### Automatic checkpoint Workflow scheduling (2026-11-24)

`MediaCheckpointWorkflow` runs a checkpointed unit to completion as durable
Workflow steps with no application loop. A JSON spec pins inputs and separates
graph, input and full spec hashes. A validation step (no retries) checks hashes,
the registry entry's implementation version and the runner preflight; each
`unit-<n>` step is one bounded runner invocation. `yielded` continues under the
same lease, `busy` persists its wake time and sleep duration and sleeps, other
errors use bounded step retries, and `cancelled`, `lease-lost`, `output-conflict`
and deterministic `TypeError`/`RangeError` failures end the instance. After
`finished` an immutable manifest with the destination size and SHA-256 is written
conditionally. `cancelMediaCheckpointWorkflow` fences the journal before
terminating and never terminates a finished journal. See
[checkpoint Workflow](media-checkpoint-workflow.md).

The runner now preflights every finalize option before its first journal call,
always finalizes through `finalizeMediaCheckpointOutput` (reporting `finished`
only for a published or verified destination and `output-conflict` for a differing
one; other finalization failures are rethrown), finalizes when a refused heartbeat finds another owner finished, and reports
component contract violations as `TypeError`. An opt-in `resumeLease` lets the
owner that yielded continue at once. The Workflow hands a lease only to an
execution nothing else can still be using, aborts each attempt at
`stepTimeoutMs - leaseMs - 1000`, and requires
`stepTimeoutMs >= (unitsPerInvocation + 2) * leaseMs + 1000`. Busy sleeps count
against `maxInvocations`. The integration item replaced `sleepUntil` with a
replay-stable `step.sleep(name, sleepMs)` after a restarted local engine rejected
a replayed past timestamp; both Workflow test files pass with that interface.

Local workerd acceptance uses the actual Workflows engine, SQLite coordinator and
R2 with the audio FIFO: across a full runtime restart (reactivated by
`pause()`/`resume()`), an in-step retry, a busy wait behind a foreign lease,
manifest replay, cancellation fencing, an output conflict and an
implementation-version rejection, output matches pinned Native FFmpeg byte for
byte (92/96 bytes) and framecrc. Lease handoff relies on the local engine's
1-based, persisted `ctx.attempt`; production Workflows were not exercised.

### Checkpoint orphan collection (2026-11-24)

`collectMediaCheckpointOrphans` deletes R2 attempt objects that one journal can
never reference. A key is deleted only when it exactly matches the attempt layout,
carries the `prepareMediaCheckpoint` digest marker, is referenced by no commit, no
lease is live, and its attempt is fenced: the journal is terminal, or it is `ready`
and the key's generation is at most the last committer's. The journal is read
before listing, after listing and before every delete batch; a live lease stops
the run and a regressed journal throws before deleting. Listing and deletion are
bounded, `next` resumes before the first key left undone, dry runs report the same
plan, and failures after deletion began throw `MediaCheckpointCollectionError`
with a partial report. The collector is explicit; nothing schedules it. One
coordinator namespace must own each bucket's `checkpoints/` prefix. See
[orphan collection](media-checkpoint-collection.md).

Local workerd acceptance drops one commit acknowledgement (that revision stays
committed) and stages orphans through the real prepare path: a lost output-put
acknowledgement, a failed output put and a stale owner whose commit is rejected. Nothing is listed under a live lease, the
`ready` journal deletes only fenced objects, and after a runtime restart bounded
runs continued by `next` remove exactly the remaining orphans while committed
objects, an unmarked attempt-shaped key and a non-attempt key remain. Committed
state and output still load, and finalize still matches pinned Native raw PCM
(32/36 bytes).

### Checkpointed WAV resampling pipeline (2026-11-24)

`createAudioCheckpointPipeline` in `@edge-ffmpeg/avformat` composes the four
checkpointable components into one runtime component: a ranged WAV read, the
resampler state, exactly one `asetnsamples` FIFO or finite `apad` stage, and the
WAV mux state. It continues
`ffmpeg -cpuflags 0 -i in.wav -af aresample=R[:tsf=<p>p],<stage> -c:a <codec> [-bitexact]`
one bounded unit at a time. One versioned canonical snapshot wraps the three
child codecs; `verify` chains every counter to the journal positions, and
`audioCheckpointPipelinePatches` derives the WAV trailer patches from the terminal
state. Unsupported codecs and stages, sizes needing RF64, unit/state bounds and
input chunks the pipeline does not model (LIST/INFO other than an `ISFT`-only
list, `bext`, ID3, `cue `, `SMV0`, `XMA2`, trailing bytes) are rejected
conservatively from the header before any sample read; every listed chunk kind
except `XMA2` has a unit test, and only the title/artist (`INAM` checked) and `bext`
rejections are backed by native output that actually carries the tag. Without a
rate change the input converts straight to the output format and `precision` is
unused, as Native's `full_convert` does.
`runtime-cloudflare` carries no media code. See
[checkpointed audio pipeline](checkpointed-audio-pipeline.md).

Differential tests restore the pipeline at every unit boundary and compare complete
WAV files with the pinned build: 720 byte-exact cases (s16 FIR on six rate-changing
pairs, the float FIR on four non-interpolating pairs as recorded fixtures, and all
nine format pairs without a rate change; 1-3 channels, both FIFO policies and four
apad modes), three cases resumed at every single unit boundary, 288 tolerance-only cases (double
FIR, interpolating float, s16 to f32 through the float FIR) and the tag rules.
Local workerd runs the pipeline through actual Workflows across a stale owner, a
dropped commit acknowledgement and a full restart, collects its orphans and still
finalizes Native-identical WAV; five fault-free cases (including an equal-rate
f32/s16/f32 case) also match, and tagged or over-budget inputs fail validation
before any object is written. Float FIR identity holds only for the recorded
fixtures.

### Full-suite validation of the checkpoint continuation waves (2026-11-24)

The previous wave (final assembly, apad state, runner) and this wave (resampler
state and strict codecs, WAV mux state and no-clobber assembly, Workflow
scheduling, orphan collection, checkpointed pipeline) were validated together
with the complete local suites rather than a selected regression. The first
invocation passed `npm run check` but `npm run test:workers` failed one existing
test: `tests/workers/mp4-copy-cli.test.ts` expects an MP4 copy refused for its
indexing budget to open no input reader (`[readerOpens, writes]` equal to `[0, 0]`)
and observed `[1, 0]`, 275/276 tests across 109 files passing. The cause was
outside the checkpoint code. The media backend's FLAC magic probe, added by the
FLAC waves after the last full Workers run, opens every undeclared input before
routing, so the MP4 copy refusal came after an open. `preflightMp4Copy` now holds
every MP4 copy check that needs no I/O; `executeMp4Copy` calls it and the
dispatcher runs it before the probe for undeclared inputs already routed to MP4
copy. The failure reproduced alone before the change and passes after it. A FLAC
input with MP4 output whose options MP4 copy rejects now fails with the MP4 copy
refusal instead of the FLAC route's; both are explicit, but no test covers that
combination. The interrupted first run is retained as superseded evidence.

The clean second invocation ran sequentially on one source snapshot:

- `npm run check`: four TypeScript configurations, declarations, ESLint and
  package boundaries passed; unit **2,587/2,587 tests across 201 files**.
- `npm run test:workers`: **276/276 tests across 109 files**.
- `npm run test:integration`: **2,080/2,080 tests across 82 files**.
- `npm run test:differential`: **516/516 tests across 198 files**.
- `npm run workers:bundle`: the dry-run bundle passed; nothing was deployed.

That is **5,459/5,459 tests across 590 files, zero failures and zero skips**. The
23 checkpoint and pipeline test files account for 543 of them (527 unit, 9 local
workerd, 7 differential). 84 new scoped contracts cover both waves. Against JSON
reports from the clean run, plus a separate unit JSON invocation that also passed
2,587/2,587, all 792 contracts (708 existing and 84 new) resolve to exactly one
passed assertion under the compatibility report's matcher. Raw logs, JSON reports
and the contract check are retained in the local, git-ignored
`.build/checkpoint-continuation/` directory, and its `receipt.json` records the
source/reference hashes and the hash of each retained file. The reframe, runner,
journal, Workflow and pipeline contributor docs were corrected for the strict
codecs, the orphan collector and the pipeline's tag rejection wording. A later
documentation-only audit corrected wording in these sections and in the resampler,
apad, WAV mux, runner, Workflow and pipeline docs; no source or test changed, so
the receipt's hashes for those docs predate the audit.

Open after this validation: float FIR identity holds only for the recorded
fixtures and double/interpolating float remain tolerance-only. The WAV mux state
is compared with Native only through the three standalone workerd cases and the
pipeline's `pcm_s16le`/`pcm_f32le`/`pcm_f64le` outputs; other codecs rely on
equivalence with the finite `muxWav`. Output PTS beyond signed64 are not
native-verified. Workflow lease handoff relies on the local engine's 1-based
persisted `ctx.attempt`, the local engine needs `pause()`/`resume()` after a
restart, and deterministic plain `Error`s raised inside a unit step (committed
digest mismatch, pipeline refusals from `process` or `restore` unless a binding
maps them) are retried before failing. After the audit, the pipeline's rejection
messages and the input-chunk unit test title were reworded so they no longer claim
that native carries every rejected chunk; `XMA2` rejection has no test. Orphan collection is not
scheduled, cannot fence a `ready` journal above its last committer and requires
one coordinator namespace per bucket. There is no lease renewal during a unit, no
release on yield, no journal beyond 256 revisions, no RF64, other containers or
codecs, multiple outputs or parallel WorkUnits. The 9,216-case resampler and
13,824-output WAV comparisons, the short-stream probe and the mutation harnesses
remain scratch evidence. No Modal run, production Cloudflare execution,
compatibility certification or capability promotion was performed.
