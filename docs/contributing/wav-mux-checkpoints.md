# Checkpointed WAV mux and header-rewriting assembly

Native FFmpeg's WAV muxer, writing to seekable output, emits a header with
placeholder sizes, then streams the packet bytes. Its trailer then seeks back
and rewrites the size fields. A checkpointed component commits its first output
chunk before the final sample count is known, so it cannot use the finite
[`muxWav`](wav-support.md#finite-pcm-output), which needs `sampleCount` up front.
This page covers two pieces:

- a checkpointable WAV mux state in `@edge-ffmpeg/containers`
- an optional, validated patch step in `finalizeMediaCheckpointOutput` that
  applies the trailer rewrites while the committed chunks stream. This is
  option 3 of design section 10.4 (assembly at final commit), using the
  `muxerStateRef` idea from section 11.4.

The page also documents the no-clobber replay contract for final assembly.
Design context: sections 9.1, 9.3, 10.4 and 11.1–11.5 of the
[detailed design](../architecture/detailed-development-design.md).

```ts
import {createWavMuxState, serializeWavMuxState, deserializeWavMuxState, wavMuxPatches} from '@edge-ffmpeg/containers';

const format = {codec: 'pcm_s16le', channels: 2, sampleRate: 8000, channelMask: 3} as const;
const options = {metadataProfile: 'ffmpeg-9.0.2', bitexact: false} as const; // signal?: AbortSignal
const mux = createWavMuxState(format, options);   // or (format, options, deserializeWavMuxState(saved))
const unit = [mux.start()];                        // first unit only: the pre-trailer header
unit.push(mux.write(packet));                      // per contiguous packet: the packet bytes (not copied)
const trailer = mux.finish();                      // terminal unit: {bytes: RIFF pad (0 or 1 byte), patches}
unit.push(trailer.bytes);
const saved = serializeWavMuxState(mux.snapshot()); // store with the unit in the committed state blob
```

## WAV mux state

`createWavMuxState(format, options, snapshot?)` supports what the finite muxer
supports under the native reference profile: `pcm_u8`, `pcm_s16le`, `pcm_s24le`,
`pcm_s32le`, `pcm_f32le`, `pcm_f64le`, `pcm_alaw` and `pcm_mulaw`, with any
channel count, rate and channel mask that `muxWav` accepts. This includes the
extensible header, high masks serialized as zero, and `bitexact` without
`LIST/INFO`. Layout, header construction and packet-timing validation are
shared with `muxWav` (`wav-mux.ts`). The finite muxer's output is unchanged. Its
existing unit and differential WAV tests still pass, and a one-off hash
comparison of 13,824 finite outputs during the refactor matched. That comparison
is not a committed test.

Native behavior modeled (the pinned `wavenc.c`/`riffenc.c`, with
`rf64=never`, `write_bext=0` and `write_peak=off`):

- `start()` returns the header as native writes it before the trailer:
  - RIFF size `0xffffffff`
  - correct `fmt ` size and body
  - for non-PCM tags (float, A-law, mu-law) a `fact` chunk whose count is `0`.
    Native writes this chunk only when the output is seekable.
  - the optional `LIST/INFO/ISFT` (`Lavf63.1.102`)
  - `data` size `0xffffffff`
- `write(packet)` accepts complete interleaved sample frames on stream 0, at
  contiguous zero-based sample positions. Equivalent rational time bases are
  accepted, as in `muxWav`. It returns the packet bytes unchanged.
- `finish()` returns the trailing bytes native appends, which is one zero byte
  when the data size is odd. It also returns the trailer's rewrites as at most
  three 4-byte `{offset, bytes}` patches, in ascending order:
  - the RIFF size at offset 4
  - the `fact` count, for non-PCM tags only. With no packets, native's
    `INT64_MAX` minimum PTS wraps the count to 1.
  - the `data` size at `headerBytes - 4`
- A packet that would make the data or RIFF size reach `0xffffffff` throws
  `WavError('unsupported', …RF64…)` before the state changes. The `rf64=auto`
  and `rf64=always` layouts are not implemented.

Every call validates before it mutates, so a rejected packet leaves the state and
its snapshot unchanged. The calls must come in order: `start` once, then
`write`, then `finish` once. Any other order throws. The state requires
`metadataProfile`. The EdgeFFmpeg default profile and other codecs fail with
`unsupported`. An unknown profile passed in `options` fails with the profile's
`RangeError`, as in `muxWav`. A snapshot whose profile is absent or unknown is
`invalid-data`.

### Snapshot codec

`serializeWavMuxState` and `deserializeWavMuxState` use strict canonical UTF-8
JSON of at most 1 KiB. The snapshot holds:

- `version: 1` and `kind: 'wav-mux'`
- the format, with the effective channel mask as a canonical decimal (an
  absent or `null` mask is `"0"`)
- `metadataProfile` and `bitexact`
- the header layout: `headerBytes`, `factOffset` and `dataSizeOffset`
- the `bytes` and `samples` counters, as canonical decimals
- the terminal `finished` flag

Decoding rejects anything that is not exactly the canonical bytes, such as
whitespace, a BOM, key order, extra keys, numeric counters or leading zeros. It
also rejects:

- an unknown version, kind or codec, and an absent or unknown profile
  (`WavError('invalid-data')`, never a bare `RangeError`)
- a stored layout that disagrees with the layout re-derived from the format
- counters that disagree: `bytes` must be 0, or `headerBytes + samples × blockAlign`, plus the pad byte once finished
- RF64-sized counters

Restoring with a different format, profile or `bitexact` value is rejected.
`wavMuxPatches(snapshot)` recomputes the patches from a finished snapshot alone.
Final assembly therefore derives them from committed state rather than from
memory.

The codec checks structure only. Persist it inside a pinned, digest-verified
checkpoint object, as the journal does.

## Final assembly with patches

`finalizeMediaCheckpointOutput` (see [journal](media-checkpoint-journal.md#final-byte-assembly))
accepts these extra options:

- `patches?: (terminal, signal) => readonly {offset: bigint; bytes: Uint8Array}[]`
- `maxPatches` (1–256, default 16)
- `maxPatchBytes` (total, 1–65536, default 4096)
- `maxReadBytes` (1–`maxObjectBytes`, default `maxWriteBytes`). This is the
  upper slice size for reading an existing destination. The VFS does not expose
  an adapter's own read limit (`createR2FileSystem`'s `maxReadBytes`), so a
  `RangeError` from `readAt` halves the slice and later slices keep the smaller
  size. That happens at most log2(`maxReadBytes`) times. Any other read error,
  or a `RangeError` at one byte, is rethrown. Set it at or below the adapter's
  limit to avoid the rejected attempts.

```ts
await finalizeMediaCheckpointOutput({bucket, status, filesystem, path: '/output/job.wav',
  maxObjectBytes: 1048576, maxWriteBytes: 65536, maxReadBytes: 65536, // write/read slices <= maxObjectBytes
  patches: ({state, bytes}) => {
    const snapshot = deserializeWavMuxState(extractWavSnapshot(state)); // application's state framing
    if (BigInt(snapshot.bytes) !== bytes) throw Error('Mux state disagrees with committed output');
    return wavMuxPatches(snapshot);
  }});
```

- **Source.** The callback receives `{descriptor, state, bytes}` for the
  terminal commit. The state comes from `loadMediaCheckpoint`, so its ETag,
  version, size and SHA-256 pins are verified. `bytes` is the journal's total
  output size. A tampered or changed terminal state or output object rejects
  before the callback runs. The runtime package does not interpret WAV; the
  callback supplies the container semantics.
- **Validation.** All validation happens before any destination is probed, read
  or opened:
  - the result must be an array within `maxPatches`
  - each entry needs a bigint offset and a non-empty `Uint8Array`, with total
    bytes within `maxPatchBytes`
  - every range must lie inside `[0, output bytes)`
  - after sorting by offset, no two ranges may overlap. Adjacent ranges are
    allowed.

  Entries are copied first, so later caller mutation cannot change what is
  written.
- **Application.** Each committed chunk is read one at a time through the
  existing pins. Every patch range that intersects the chunk is applied to it,
  including a patch that spans a chunk boundary, before the chunk is written in
  `maxWriteBytes` slices. The whole file is never buffered. Patches cannot change
  the output length, so appended bytes, such as WAV's pad byte, must be
  committed output.
- **Cost.** The terminal state load also re-reads the terminal output chunk,
  because `loadMediaCheckpoint` returns both objects. That read is bounded by
  `maxObjectBytes`. In exchange, a tampered terminal chunk is rejected before
  any destination is probed or opened.

The journal schema (`state.ts`, `durable-object.ts`) is unchanged, and existing
journals remain readable. Without `patches`, assembly is byte-identical to the
previous concatenation.

## No-clobber destination contract

When `overwrite !== true`, `filesystem.outputExists(path, signal, {overwrite: false})`
is probed before a writer is opened. If the destination exists:

1. `filesystem.openRead(path)` is opened and its size is compared with the
   journal's output size.
2. If the sizes are equal, the committed chunks are streamed again, with the same
   pins and patches, into an incremental SHA-256. The existing object is then
   read in slices of at most `maxReadBytes` (halved after a `readAt`
   `RangeError`, as described above) into a second SHA-256. WebCrypto digests are
   one-shot, so a small FIPS 180-4 implementation keeps memory bounded. Unit
   tests check it against `node:crypto` at block boundaries.
3. Identical content returns the normal result plus `existing: true`. Different
   content throws the exported `MediaCheckpointOutputConflictError`, which
   carries `path`, `expected` and `actual` `{bytes, sha256}`. The digests are
   `null` when the sizes already differ.

Neither outcome opens a writer or creates staging. A tampered journal chunk
during verification fails with the integrity error, not with a conflict.

Races and commit failures after the writer is open:

- **Appears before commit.** If the pre-commit recheck finds the destination, the
  writer is aborted once, which aborts the R2 multipart upload. Verification as
  above follows.
- **Uncertain or published.** `R2CommitUncertainError`, and published errors such
  as `R2OutputCleanupError` (`published: true`), are rethrown without abort.
  Staging is kept for `recoverPublishedR2Output`. These are the only commit
  failures that keep staging.
- **Any other commit failure** is definite for this writer. Examples are the R2
  adapter's `R2 output already exists` (a lost conditional put), `R2 staging
  integrity check failed`, and a part upload or completion failure. The writer
  is aborted once first. In R2, that deletes the completed staging object or
  aborts the multipart upload. Then the destination is probed again:
  - if it exists now, it was a lost no-clobber race, and verification as above
    follows
  - if it is absent, including a competitor deleted before the probe, the commit
    error is rethrown

  A cleanup failure is an `AggregateError` of the commit and cleanup errors,
  with no probe. A failed probe, including one cancelled by the signal, is an
  `AggregateError` of the commit and probe errors, after staging was discarded.
  `abort()` only touches staging. An adapter that cannot tell whether its own
  commit published must say so in the error (as R2 does) or keep what its
  recovery needs when aborted (R2's `uncertain` state makes abort a no-op).
  avformat's output group makes the same assumption when it aborts uncertain
  entries.

`overwrite: true` keeps its previous semantics: no probe, and replacement only
after every chunk has been verified and staged. A failed replacement commit is
discarded the same way. Verification needs the adapter's `outputExists`, which
the VFS declares optional; avformat's output policy treats a missing one as
absent in the same way. Without it there is no probe: an existing destination
gets a writer and staging, the lost no-clobber commit discards that staging, and
the adapter's error is rethrown instead of a verification result. Both
`createR2FileSystem` and the Node filesystem implement it.

## Verified evidence

- [Unit: WAV state](../../tests/unit/wav-mux-checkpoint.test.ts) covers 768
  combinations: 8 codecs × 8 layouts and masks × 2 rates × `bitexact` × 0/1/7
  samples. Each continues through a serialize and restore round trip before every
  packet, with three-sample packets and equivalent time bases. The patched
  concatenation must equal finite `muxWav` (native profile) byte for byte, and
  the only differing bytes must lie in the rewritten fields. Its oracle is the
  finite muxer, not Native: it shows equivalence to `muxWav`, whose own Native
  evidence is the [WAV differential tests](wav-support.md). The test also
  covers:
  - the zero-packet fact count
  - exact canonical encoding and rejection of non-canonical or inconsistent
    snapshots, including absent, `null` and unknown profiles as `invalid-data`
  - configuration mismatch
  - unchanged state after rejected packets
  - call order
  - RF64 failure near the size limit
  - abort
- [Unit: assembly](../../tests/unit/media-checkpoint-output.test.ts) covers:
  - patch application across chunk and write-slice boundaries
  - verified terminal state and signal passed to the callback
  - copying of patch bytes
  - every invalid patch list shape, range, overlap and bound, rejected before
    `outputExists` or `openWrite`
  - tampered terminal state and output
  - identical, different-content, different-size and empty existing destinations
  - a short read
  - a destination appearing before commit
  - a definite commit loss, with abort once, then verify
  - uncertain and published commits, with staging kept
  - an unclassified commit failure and a failed overwrite commit, each aborted
    once and rethrown
  - absent-after-failure (abort before the probe), inspection failure, a signal
    cancelled during the probe, and cleanup failure
  - verification read slices halved after an adapter `RangeError`, within an
    explicit bound, a bounded give-up, and other read errors rethrown at once
  - SHA-256 equality with `node:crypto` for three write/read slice pairs and edge lengths
- [Workerd](../../tests/workers/wav-mux-checkpoint.test.ts) uses its
  [fixture](../../tests/workers/wav-mux-checkpoint-fixture.ts), the real SQLite
  `MediaCheckpointCoordinator`, local R2 and `runCheckpointedMediaUnit`. The
  component is the `createAudioReframeState` FIFO (`asetnsamples=n=3`) feeding
  the WAV mux state. Each unit is a five-sample pinned R2 range read, and the
  state blob is the FIFO checkpoint plus the WAV snapshot. Three cases run:
  - `s16-pad`: stereo s16, `p=1`, default `LIST/INFO`
  - `u8-odd`: mono u8, `p=0`, `-bitexact`, odd data with a pad byte
  - `f32-fact`: stereo float, `p=1`, fact patch

  Each case runs 23 samples in three invocations (2, 1 and 2 units) with a
  destroyed runtime and lease expiry between them. The test then checks:
  - The published object equals the pinned Native command byte for byte:
    `ffmpeg -cpuflags 0 -f <raw> -ar 8000 -ac <n> -i in -af aformat=sample_fmts=<planar>,asetnsamples=n=3:p=<pad> -c:a <codec> [-bitexact] out.wav`
  - The unpatched committed stream differs from that output only in the
    rewritten fields, and holds the placeholders.
  - For the PCM cases, it equals Native `-f wav pipe:1` output, plus the pad byte
    for `u8-odd`.
  - For float, it equals the pipe output once its seekable-only `fact` chunk is
    removed.
  - A replay returns `existing` without opening a writer or changing the version.

  Staging is observed two ways. `stages` lists objects under the staging
  prefix, which finds completed staging objects. `live` resumes every multipart
  upload the adapter created and counts those that still accept a part, which
  finds unfinished uploads that a listing misses. A control checks that `live`
  reports an open upload as 1 and an aborted one as 0 in this emulation.
  The `s16-pad` case also covers:
  - same-size and different-size conflicts, with nothing opened or replaced
  - an identical or conflicting competitor appearing before the recheck, with
    the multipart upload aborted (`live: 0`) and the winner verified
  - an identical or conflicting competitor winning the conditional put, with the
    completed staging object deleted (`stages: 0`) and the winner verified
  - a staging integrity failure, and a competitor that wins the put and is
    deleted before the probe. Both rethrow the commit error, leave no staging
    object or live upload, and leave the destination absent.
  - an uncertain publish that keeps one staging object, until
    `recoverPublishedR2Output` confirms it, after which a replay verifies
  - out-of-range and overlapping patches, rejected with nothing opened
  - explicit overwrite
  - a tampered terminal state blocking both a new publication and replay
    verification

## Not implemented

- RF64/`rf64=auto|always`, `write_bext`, `write_peak` and other muxer options.
  Unknown-size streaming without final assembly is also not implemented.
  Concatenating chunks without patches equals Native pipe output only for PCM
  tags with even data size, as tested. For non-PCM tags, Native non-seekable
  output omits `fact`.
- Packets whose timestamps do not start at sample zero, timestamp gaps, and
  muxers other than WAV. Patch derivation is container code supplied by the
  application; the runtime only validates and applies byte ranges.
- Patches that change the output length, multiple outputs, and remux or index
  rewriting (for example MP4 `moov`).
- Verification CPU is proportional to the output size: two streamed SHA-256
  passes plus a re-read of every committed chunk. Byte limits bound individual
  objects and reads, not total heap or CPU.

On this page, Native parity of the continuation is shown only for the three
workerd cases above (`s16-pad`, `u8-odd`, `f32-fact`, all 8 kHz, 23 samples). The
[checkpointed audio pipeline](checkpointed-audio-pipeline.md#verified-evidence)
also compares complete WAV files written through this mux state with Native, for
`pcm_s16le`, `pcm_f32le` and `pcm_f64le` output with 1 to 3 channels at the rates
listed there. Other codecs (`pcm_u8` beyond `u8-odd`, `pcm_s24le`, `pcm_s32le`,
G.711), other masks and other rates are covered only through equivalence with
finite `muxWav`. This is local workerd and Node evidence against the pinned Native
build. It does not establish production deployment readiness or full FFmpeg WAV
compatibility.
