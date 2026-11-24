# Hash muxers (md5, hash, crc, streamhash)

Output-only whole-stream digest muxers, ported from `libavformat/hashenc.c` and `crcenc.c` at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. They are registered in the container registry (`packages/containers/src/registry.ts`, one line per name) from `packages/containers/src/hash/hash-mux.ts`; the digests live in `packages/containers/src/hash/digests.ts` (no avutil barrel edit). Notice: `packages/containers/NOTICE-HASH`.

## Scope

| `-f` | Output (one line) | Digest |
|---|---|---|
| `md5` | `MD5=<hex>\n` | MD5 (RFC 1321) |
| `hash` | `SHA256=<hex>\n` | SHA-256 (FIPS 180-4) |
| `crc` | `CRC=0x%08x\n` | adler32 seeded with 1 (framecrc uses 0) |
| `streamhash` | `0,a,SHA256=<hex>\n` | SHA-256 of stream 0 |

- The digest covers the concatenated encoded packet payloads of the single PCM output stream. Packet boundaries and timestamps are not hashed, so the output does not depend on the memory plan's re-chunking.
- Default codec `pcm_s16le`; every implemented PCM codec (all 20 in `PcmCodec`) and `-c copy` are accepted. Filters (`-af`), `-t` and `-frames:a` work as on every PCM output.
- Descriptor: `mux` only, no extensions (native has none), `scratchBytes:256`, `dropsMetadata:true` (native writes no tags), `options:['-hash']` on md5, hash and streamhash as in native's `AVOption` tables; crc declares none.
- `digests.ts` also implements SHA-1 (`sha160`), SHA-224 and CRC-32 (`AV_CRC_32_IEEE_LE`, as `av_hash` uses it) for a future `-hash`, with unit vectors only.

## Evidence (Linux x86_64 oracle)

- `tests/differential/hash-muxers.test.ts`:
  - 1440 byte-for-byte file comparisons: 20 PCM codecs × channels {1,2,6} × rates {8000,44100} × lengths {0,1,4097} samples × 4 muxers, from s16le raw input encoded with `-c:a <codec>`.
  - 48 comparisons over 12 profiles × 4 muxers: `-cpuflags 0 -af volume=0.5` (s16le, and fixed precision to `pcm_f32be`), output `-t 0.05`, `-frames:a 3`, WAV `-c copy` with and without `-t`, WAV decode, and raw `-c copy` of five codecs.
  - 8 refusal checks: Edge refuses `-hash murmur3` and `-hash sha256` (`invalid-arguments`, `Unsupported option: -hash`) with no output file; native accepts both (exit 0) and its output is recorded.
- `tests/unit/hash-digests.test.ts`: RFC 1321, FIPS 180-4 (SHA-1/224/256, including one million `a`), CRC-32 and adler32 vectors; chunk-boundary independence including 128-byte chunks; abort checks; descriptor fields; mux write budgets (128 and 7 bytes); abort-once on write failure, invalid packets, invalid budgets and cancellation; `-hash` refusal in `validate`.

## Unsupported

- `-hash` (any value): the CLI parser refuses it before any backend runs, and `packages/cli` is outside this change. `validate` also refuses any `-hash` value, so enabling the CLI entry alone would not silently ignore it. Once the CLI knows the option, md5/sha160/sha224/sha256/crc32/adler32 can be supported from `digests.ts`; murmur3, ripemd*, sha384 and sha512* would need new digests.
- `framemd5` and `framehash` (deferred).
- Video (rawvideo) input to these muxers: `raw-video.ts` is outside the registry.
- FLAC input: the FLAC output dispatcher does not iterate the registry.
- Multiple streams (streamhash prints only stream 0, the only stream the PCM path has).

## Side effect

The registry's supported-output listing now reads `WAV, AIFF, AU, W64, framecrc, crc, hash, md5, streamhash`, so the generic `Output requires ... or an explicit raw PCM format` refusal names them too. This is the registry's designed behaviour for unordered muxers; `tests/unit/container-registry.test.ts` passes unchanged.
