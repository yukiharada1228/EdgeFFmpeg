# EdgeFFmpeg

TypeScript / WebAssembly media processing for Cloudflare Workers, targeting the behavior of a pinned FFmpeg reference build.

This repository is in early development. A partial raw-PCM/WAV/AIFF/AU path supports copy, sample-format conversion, mono/stereo remix and scoped time selection on Node and local workerd/R2. Default PCM/G.711 sample-rate conversion is partial. A first finite rawvideo path supports declared 8-bit packed/planar layouts, copy/rawvideo encoding, scoped time selection, RGB/YUV component packing, default RGB/YUV/gray color conversion, bicubic chroma resampling, explicit-profile subsampled YUV-to-RGB, gray/YUV/RGB output-size resizing with supported fused format conversion, bounded null/scale/format/hflip/vflip/transpose/split/nullsink/hstack/vstack video graphs with candidate-list output negotiation and framecrc. General compressed codecs, general filters and distributed execution remain unimplemented. No FFmpeg runtime dependency is introduced by the library packages; native FFmpeg is used only for development conformance testing.

A scoped [MP4 packet-copy path](docs/contributing/mp4-mux.md) adds bounded
nonfragmented video/audio packet reading, metadata-only planning, transactional
muxing and one-input/output CLI streamcopy with Native-tested selection and R2
publication recovery. Scoped video edit lists include leading delays, repeated
intervals and zero-packet streams. Opt-in [H264 decoding](docs/codecs/h264.md)
connects MP4 to rawvideo/framecrc through the trusted Wasm module. General
compressed decoding/encoding and MP4 semantics remain unfinished.

An explicit [timed video backend](docs/contributing/timed-video-backend.md) adds
bounded actor execution, crop/aspect handling, frame scale expressions and
neighbor/bilinear/area interpolation, with public R2 event spooling. These remain
scoped partial implementations; full resource, production runtime and distributed
recovery support is unfinished.

The public FLAC APIs now expose bounded packet parsing and `openFlacDemux`,
which combines STREAMINFO, ordered comments, chapters, provisional channel
layouts and encoded attached pictures with backpressured packet chunks.
Default sample timestamps and legacy picture continuation have scoped Native
comparisons. A bounded libFLAC Wasm decoder and CLI routes now produce PCM,
WAV, AIFF, AU and framecrc; packet copy to framecrc is also available. The Node launcher
accepts `--flac-wasm .build/codecs/flac/edge-flac.wasm` before `--` and verifies
the pinned module. Build instructions are in [the codec recipe](tools/codecs/flac/README.md).
Bounded prepasses support decoded frame limits and unknown total sample counts.
Scoped output time selection, mono/stereo remix, finite audio filters and scalar
rate conversion now use the public backend; scalar-sensitive conversions require
`-cpuflags 0`. Time selection can be combined with `anull` and constant `volume`
and scoped scalar output-rate conversion. Input duration is applied before FIR,
output time selection after FIR; see [timed-rate evidence](compat/behavior-specs/flac-timed-rate/README.md)
and [timed-filter evidence](compat/behavior-specs/flac-timed-filters/README.md).
Time selection also supports singleton `aformat=sample_fmts=…` at unchanged rates;
see [format-conversion evidence](compat/behavior-specs/flac-timed-aformat/README.md). Native-FLAC packet-copy output supports bounded comments and padding
without loading a decoder. Scoped input/output `-t` and `-to` limits now retain
whole compressed packets, following Native microsecond timestamp rounding; see
[copy-duration evidence](compat/behavior-specs/flac-copy-duration/README.md). See the [combined evidence and explicit gaps](compat/behavior-specs/flac-max-combined/README.md).
General AVIO/error-policy parity, malformed-input parity, input seeking,
picture/chapter preservation, arbitrary filter/rate scheduling and FLAC encoding
remain unfinished. See the
[development status](docs/contributing/development-status.md) for scoped evidence
and changes made after the historical full validation below.

## Latest development validation

Full local validation v35 passed 1,242 tests with no skips: 565 unit,
84 integration, 358 differential and 235 Workers tests. All 624 scoped
comparison contracts and 14 required gates passed, including five reviewed
FATE profiles. Source and reference hashes remained stable throughout the run.
The tested source snapshot is `a82b92caff2865e3b0680ee97415998b46b483b21484a42cc9c06c478267daf5`.

This is development validation against the recorded local Native oracle and
local workerd. It does not establish canonical Linux, production Cloudflare,
complete FFmpeg compatibility or release readiness. The capability manifest
still records 165 partial and 2,334 unimplemented entries, with none certified
conformant or bitexact. Earlier failed runs remain recorded.

## Development

Requires Node.js 24+, npm, Git, a C compiler and Make.

```sh
git submodule update --init
npm ci
npm run check
npm run reference:build
npm run codec:h264:build -- --source /path/to/clean/openh264 --emsdk /path/to/pinned/emsdk
npm run test:integration
npm run test:workers
npm run workers:bundle
npm run reference:extract
npm run fate:inventory
npm run test:differential
```

The H264 differential and Workers tests require the explicitly built codec
module. See [the H264 guide](docs/codecs/h264.md) for the pinned SDK/toolchain
and source staging procedure. Foundation unit checks do not require that build.

The root `vitest.config.mjs` limits regression discovery to `tests/` so archived
evidence cannot be executed as another copy of a test suite. For an individual
working probe in `.build/`, pass `--config tools/testing/staged.config.mjs`
explicitly; that configuration excludes saved evidence and snapshot directories.

The reference build verifies `compat/upstream.lock.json` before configuring the submodule source. Linux x86_64 is the canonical target; local builds on other platforms are development oracles, not evidence of canonical binary compatibility. Automatic external-library detection is disabled. The current reference uses built-in codecs and the exact configure flags in `compat/configure.flags`; it does not include libx264.

Current packages:

- `core`, `cli`, `avutil`: public frontend, graph/registry primitives, CLI parsing and integer media-time types.
- `avformat`, `avcodec`, `containers`, `swresample`, `swscale`, `avfilter`: the documented audio/rawvideo execution paths and scalar sample-format conversion.
- `runtime-node`, `runtime-cloudflare`, `storage-r2`: local/staged I/O, per-execution context and opt-in staged R2 output.

Only the documented backend subsets are executable. createMediaBackend is the current factory; createWavBackend remains an alias.

See [the detailed design](docs/architecture/detailed-development-design.md) for the complete target and phases. Project-wide public licensing remains pending the design's dependency/provenance audit. Component-specific notices and licenses apply to their named files, including the [swscale adaptation](packages/swscale/NOTICE).

Capability extraction currently overwrites the local manifest with platform-specific evidence. A local manifest does not assert conformance. FATE inventory only lists definitions; `npm run fate:run` executes five reviewed upstream cases with pinned input and explicit adaptations. See [FATE execution](docs/contributing/fate-execution.md). See [development status](docs/contributing/development-status.md) for remaining work.

[WAV support scope](docs/contributing/wav-support.md) documents the first partial container implementation and its native/workerd tests.

[Node filesystem adapter](docs/contributing/node-filesystem.md) provides local reference/development I/O; Core and Cloudflare packages remain free of Node built-ins.

## First executable path

Finite PCM WAV stream copy is available through an explicit WAV backend. For an existing directory containing input.wav:

```sh
npm run ffmpeg -- --root ./media -- -n -i /input.wav -c copy /output.wav
```

See [CLI execution scope](docs/contributing/cli-execution.md) for the TypeScript API, supported arguments, result semantics and remaining limitations. Unsupported codec/filter options fail explicitly.

[Staged R2 output](docs/contributing/r2-output.md) connects the WAV backend to persistent R2 objects with explicit write mounts and transaction recovery markers.

[PCM conversion](docs/contributing/pcm-support.md) supports explicit integer bit-depth conversion, for example `-c:a pcm_u8`, and same-format floating PCM processing.

Generate [development compatibility evidence](docs/contributing/compatibility-report.md) with `npm run compat:report` after building the native reference. The report separates scoped test success from full compatibility claims.

[Scalar sample-format conversion](docs/contributing/sample-format-conversion.md) adds integer/floating and floating precision conversions. Float-to-integer CLI processing currently requires `-cpuflags 0` and finite input within the documented scalar magnitude bound.

[PCM frame limits](docs/contributing/frame-limits.md) add output `-frames:a`/`-aframes` with native packet-count semantics, independent of I/O chunk size.

[PCM time selection](docs/contributing/time-selection.md) supports scoped `-ss`, `-t` and `-to`, with native copy/encode boundary differences and EOF limitations recorded explicitly.

[Audio filters](docs/contributing/audio-filters.md) adds [stateful reframing](docs/contributing/asetnsamples.md), [rate reinterpretation](docs/contributing/asetrate.md), packed `anull` and constant `volume` chains, including fixed/float/double precision, Q8 integer arithmetic and R2 output.

[Raw PCM input/output](docs/contributing/raw-pcm.md) adds twenty headerless formats, declared rate/channels, format-specific default encoders and R2 streaming output.

[PCM payload memory planning](docs/contributing/pcm-memory-planning.md) adapts physical read sizes to conservative aggregate buffer reservations and rejects excessive FIFO work before output. Real heap/GC and adapter memory observation remains incomplete.

[G.711 A-law/mu-law](docs/contributing/g711.md) adds companded PCM codecs, raw/WAV I/O and exhaustive native/workerd domain comparisons.

[PCM representations](docs/contributing/pcm-representations.md) adds big-endian, signed8 and unsigned16/24/32 codecs with byte-preserving float endian conversion and container-specific WAV guards.

[AIFF/AIFC](docs/contributing/aiff-support.md) adds finite chunked input/output, magic probing, nine codecs and native packet/time semantics with staged R2 verification.

[Mono/stereo remix scope and arithmetic profiles](docs/contributing/channel-remix.md) document output `-ac` conversion and reference-dependent rounding.

[AU container scope](docs/contributing/au-support.md) covers eight PCM/G.711 encodings, bounded annotation skipping and sequential known-size output.

[Default audio resampling core](docs/contributing/resampling.md) provides bounded s16/flt/dbl library and scoped PCM/G.711 CLI rate conversion, including phase interpolation fallback.

[Scoped aformat constraints](docs/contributing/aformat.md) support packed singleton sample formats and automatic filter/rate negotiation.

[Planar audio conversion](docs/contributing/planar-audio.md) supports library-level packed/planar precision conversion with bounded aggregate output planes.

[Initial rawvideo support](docs/contributing/raw-video.md) adds finite packed/planar video frames, rational frame rates, headerless I/O and native framecrc comparisons. Component-preserving RGB/YUV packing conversion is available; default BT.601 RGB/YUV444/gray conversion and [8-bit resizing](docs/contributing/pixel-resize.md) are also available. Compressed video and general color conversion remain future work.

[Default video color conversion](docs/contributing/pixel-color.md) records the fixed-point matrix, range/rounding behavior, supported pairs and native/workerd evidence.

[Default chroma resampling](docs/contributing/chroma-resampling.md) adds all YUV layout pairs and RGB-to-subsampled-YUV paths with bounded coefficient/workspace storage and recorded LGPL provenance.

[Inverse YUV color conversion](docs/contributing/pixel-inverse.md) records AArch64/scalar/x86_64 arithmetic profiles, preserved intermediate precision and an explicitly rejected nondeterministic native semiplanar condition.

Bounded one-source split video graphs and named multiple outputs are described in
[the complex video guide](docs/contributing/complex-video.md), including resource
and recoverable publication limits.

[Multiple-input frame APIs and finite rawvideo CLI execution](docs/contributing/multi-input-video.md)
provide synchronized batches, finite version-bound replay streams and multiple
rawvideo CLI inputs with scoped output clocks, `-fpsmax`, and bounded SI/binary/dB
and hexadecimal encoder-clock expressions. General stream selection and
compressed media remain incomplete.


Root v32 passed1193tests/590contracts/14gates with stable source/reference
identities. Four further filesystem/read-error continuations are now integrated.
Their isolated checks include555unit tests,scoped Native and local workerd
comparisons,and resolved dynamic registration. Root checks and the next full
validation,v33,are pending for1214tests/604scoped contracts.

The continuations cover zero explicit AAC-frequency/MDHD fallback,selected-stream
mux failures,graceful overwrite refusal,default and six timed multi-output
schedulers,and typed initial input/missing local output-parent statuses.
[Execution statuses and VFS policy](docs/compatibility/execution-exit-codes.md)
describe the scoped0/234/254results,cancellation,publication effects and adapter
requirements. AAC compressed decoding,full MOV/MP4 behavior,generic error/log/
permission protocol,production Workers and full FFmpeg compatibility remain
unfinished. Later publication races can still produce explicitly reported
partial effects;cross-object atomic commit is not claimed.


### Initial directory reads and normal raw multi-input selection (scoped continuation)

The integrated continuation handles initial directory reads separately from opening inputs. Fixed Native evidence retains1,932cases:all statuses match,1,600cases match complete output existence/bytes,and332cases retain386known output differences. No metadata or publication differences are counted as exact output matches. The default raw multi-input/output path now uses bounded replay and preserves each accepted input generation. Six explicit timed schedulers retain selected-input diagnostics and ignore unused directory read failures,matching the tested Native cases.

These changes have scoped Node and local workerd evidence,not full conformance. Valid headered BMP/MP4/H264 xerror policy,general midstream I/O,non-bitexact metadata,full OS behavior and production verification remain incomplete. See `compat/behavior-specs/node-input-directory/README.md` and `compat/known-differences/node-input-directory.json`. Eleven new contracts bring the current Root to604contracts and an expected1,214Vitest tests;dynamic collection is registration evidence only,and full Root v33 validation is still pending.


### Reference serialization metadata continuation (isolated)

A separate candidate selects the fixed FFmpeg9.0.2 mux serialization profile on CLI paths while retaining low-level API defaults. Default WAV INFO/ISFT and framecrc software identity match the target;bitexact output suppresses them. Scoped WAV layout/empty-fact fields and H264 output-fflags-bitexact are covered by336Native cases/462executions with complete byte equality. The unchanged1,932directory cases retainallcaseIDs:32metadata differences are now resolved,1,632outputs-case sets are exact,and300cases/354output differences remain. Native regeneration matches across independent directories. This is not full metadata/mux or production conformance.


### Node launcher build-cache continuation (isolated)

A separate candidate reuses verified compiled launchers for matching trusted workspace source/configuration,while every invocation still validates arguments,verifies any codec module and executes a fresh job. Source/file additions and workspace-link changes invalidate or disable caching;corruption rebuilds;unavailable caches fall back to fresh compilation. The original256labelled-case Native integration and60-second limit are unchanged and pass scoped cached runs. Alternating small-command measurements observed about97ms->67ms mean subprocess wall time under concurrent validation load;this is not media throughput or a full-suite result. Rootv33stillhas an authoritative integration timeout and remains frozen while its remaining suites run.

### Metadata and WAV remediation: v34 validation failed

The terminal v33 development run failed solely on the original 256-case Node
launcher integration test's 60-second timeout; its other 1,213 tests passed,
with stable source and reference artifacts. That failure remains recorded.
The launcher cache, fixed-reference metadata serialization and scoped WAV
channel-layout corrections are now integrated with Native differential and
actual workerd evidence. The full v34 run finished with 1,225 of 1,229 tests
passing and four timeouts (three differential tests and one Workers test),
with stable source and reference artifacts. That failed run remains recorded.

Two exhaustive video differential matrices now use at most two independent
Native child processes, with case-local inputs, cancellation and awaited cleanup.
All 18,816 resize and 10,080 negotiation byte comparisons and their original
180/120-second deadlines are retained. Separate candidate runs passed in about
94/40 seconds; these observations do not establish a full-suite pass. Four
process-lifecycle unit tests are added. The subsequent full v35 validation passed.
Targeted green checks do not establish complete FFmpeg compatibility.

### Scoped default channel-layout support

CLI defaults for raw PCM/WAV to WAV and framecrc now use all13 default layouts
returned by the fixed Native libavutil API, including10/12/14/16/24channels.
Native-profile WAV output accepts exact unsigned64-bit semantic masks while
preserving the existing legacy numeric-mask behavior. The Native reference
serialization rules remain explicit; this is not general multichannel codec
conformance. Scoped validation covers512API outputs,512independent Node CLI
outputs and512actual-workerd cases, plus the layout/mask controls. These changes
are included in the passing full v35 validation with1,242tests/624contracts.

### R2 output staging buffers

Small writes start with at most4KiB of staging capacity, bounded further by
the declared output limit. The buffer grows once when needed, while multipart
part sizes and atomic publication remain unchanged. Real workerd tests compare
whole output hashes across small, budget-limited, growing and multipart writes.
These checks do not prove production Worker peak memory.
