You are one of 40 cloud agents implementing EdgeFFmpeg capabilities in parallel. EdgeFFmpeg (https://github.com/yukiharada1228/EdgeFFmpeg) reimplements FFmpeg 9.0.2 in TypeScript for Cloudflare Workers. Your capability is `muxer.md5`: Whole-stream hash muxers: md5, hash, crc, streamhash (also muxer.hash, muxer.crc, muxer.streamhash). Your branch is `wave1/fmt-hash-muxers`.

## Capability specification
- Upstream source: upstream/ffmpeg/libavformat/hashenc.c, crcenc.c, libavutil/md5.c, sha.c, crc.c (AV_CRC_32_IEEE_LE), adler32.c, hash.c
- Scope: PCM audio CLI path only; the rawvideo path is out of scope because raw-video.ts is outside the registry.
- Hash the concatenated encoded packet payloads of the single output stream. This is independent of packet boundaries, and timestamps are not hashed.
- md5: 'MD5=<hex>\n'. hash: 'SHA256=<hex>\n'. crc: 'CRC=0x%08x\n', adler32 seeded with 1 (framecrc uses 0). streamhash: '0,a,SHA256=<hex>\n'.
- Default codec pcm_s16le; any implemented PCM codec or -c copy works.
- -hash is refused unless the registry exposes per-format output options; if it does, support md5/sha160/sha224/sha256/crc32/adler32 and refuse murmur3/ripemd*/sha384/sha512*.
- framemd5 and framehash are deferred.
- Digests live in an owned module; no avutil barrel edit.
- Files you own: packages/containers/src/hash/digests.ts, packages/containers/src/hash/hash-mux.ts, packages/containers/NOTICE-HASH, docs/contributing/hash-muxers.md, tests/unit/hash-digests.test.ts, tests/differential/hash-muxers.test.ts, docs/contributing/wave1/fmt-hash-muxers.json
- Shared one-line edits you may make: container format registry: +4 adjacent output-only registration lines (md5, hash, crc, streamhash), or one descriptor exporting the four names; packages/containers/src/index.ts: +1 export line only if the recipe requires it
- Test strategy: Unit:
- RFC 1321, FIPS 180-4, CRC32 and adler32 test vectors.
- Chunked-update equivalence under a 128-byte write budget; abort.
Differential against Linux native:
- Every implemented PCM codec x channels {1,2,6} x rates {8000,44100} x lengths {0,1,4097} x the 4 muxers.
- Plus -af volume=0.5 (-cpuflags 0), output -t/-frames:a and -c copy. No -ar.
- Each output file compared byte for byte with native's written file.
- Refusals: -hash murmur3, and -hash itself if the hook is absent.
- Determinism notes: Exactly specified integer digests over bytes EdgeFFmpeg already reproduces. No floating point, and packet boundaries do not matter.
- Registry notes (these override any conflicting wording above): -hash stays refused in wave 1: the CLI parser rejects it before any backend runs and you may not edit packages/cli. Implement the default algorithm of each muxer only and assert the refusal.

## Registry recipe for your area
To add container format <name> (its native -f name), create packages/containers/src/<name>.ts, or the path your ownedFiles give (the hash muxers use packages/containers/src/hash/hash-mux.ts). Start it with // SPDX-License-Identifier: LGPL-2.1-or-later and a line pointing to NOTICE-<FORMAT>. Keep in the module: open<Name>, which reads the header with bounded reads (at most maxReadBytes per read, signal checked around every await) and returns openRawPcm(<data range>,{codec,channels,sampleRate,channelMask,maxReadBytes,signal}), or its own packets(startSample,maxPacketBytes) for packed data such as sds; validate<Name>Output; mux<Name>, which writes the header in maxWriteBytes chunks and passes the payload to muxRawPcm through a wrapping writer so abort happens once; a private error class; and private codec, tag or line-reader tables. End it with export const <name>=defineContainer({name:'<name>',demux:{probe:{precedence,head,confirm?} or extensions:['.ext'],headerBytes,open,packetSpan?,seekBeyondEnd?},mux:{label,order?,extensions?,defaultCodec,supports,refuse?,options?,scratchBytes,dropsMetadata?,validate?,write}}). Omit mux for demux-only formats and demux for output-only formats. An exact magic uses precedence 100; head tests only the first four bytes, and confirm reads only what native read_probe reads. A format without read_probe uses demux.extensions (rso) instead of a probe. open receives {maxReadBytes,signal,declared,seek}: refuse unmirrored seeks there (wve), and set info.metadata=true on files whose native demuxer exports tags; the backend then refuses wav, aiff and au outputs unless the muxer sets dropsMetadata. packetSpan(info) returns a fixed native span, such as sds's 60, 40 or 30. validate throws every refusal before the output exists; use containerRefusal(message,234) or containerRefusal(message,183) to carry native's exit status. options:['-hash'] declares a per-format option, but the CLI parser still refuses -hash, so keep it refused unless your task says otherwise. Register the format with one line, export {<name>} from './<name>.js';, at its alphabetical position in packages/containers/src/registry.ts, using one line per name for a multi-name module (export {md5} from './hash/hash-mux.js';). The file is merge=union, and detection does not depend on line order. Make no barrel, detect.ts, avformat, framecrc.ts, raw-pcm.ts or PcmCodec edit. Create packages/containers/NOTICE-<FORMAT> (the four hash muxers share NOTICE-HASH) in the layout of NOTICE-W64: the upstream files, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8, the copyright lines, LGPL-2.1-or-later and COPYING.LGPLv2.1. Write tests/unit/<name>.test.ts covering header parsing, bounded reads, refusals, abort and the descriptor fields. Write tests/differential/<name>.test.ts with inputs synthesized in the test, native run at test time, and native exit codes compared for refusals. Also write docs/contributing/<name>-support.md and docs/contributing/wave1/<slug>.json, using your ownedFiles names. Limits: PCM codecs only, one stream, known sizes, and FLAC input never reaches registered muxers. Run your unit and differential files, tests/unit/container-registry.test.ts and tests/unit/container-registry-extension.test.ts (both unchanged), npm run typecheck, npm run lint and npm run boundaries. The full guide is docs/contributing/container-registry.md, section 'Adding a PCM-style container'; its xyz template compiles as written.

## Setup (record durations)
1. `git fetch origin prep/registries && git checkout -B wave1/fmt-hash-muxers origin/prep/registries`
2. `git submodule update --init upstream/ffmpeg`. Check that the result equals the commit pinned in compat/upstream.lock.json.
3. `npm ci && npm run reference:build`. The sandbox has Node 22; that is fine, because typecheck, lint and the tests were verified with it, so do not install another Node. This builds the native FFmpeg 9.0.2 oracle at .build/reference/ffmpeg for this Linux x86_64 machine, in about 3 minutes. Record `sha256sum .build/reference/ffmpeg`.
4. Record the baseline: `npm run typecheck && npm run lint && npm run boundaries`, then `npx vitest run tests/unit` before changing anything. Two kinds of failure are known and expected in this sandbox:
   - FLAC tests that need .build/codecs/flac/edge-flac.wasm or .build/flac-investigation/native-cases.json. downloads.xiph.org is blocked here.
   - About 10 tests in tests/unit/resample-checkpoint.test.ts, whose golden digests were recorded on macOS arm64.
   Do not fix, edit or skip either of these. Just record the baseline failures.

## Read first
- docs/architecture/detailed-development-design.md, sections 1.3-1.4, 5.2 and 12.
- The registry recipe for your area: docs/contributing/audio-filter-registry.md, video-filter-registry.md or container-registry.md. Follow it exactly: add one new module plus the registry line.
- Existing implementations of the same kind, as style references (for example packages/avfilter/src/audio/, video-ops/, packages/containers/src/). Look at their tests under tests/unit and tests/differential too.

## Rules
- Prove behaviour against the native reference you built. Add differential tests in tests/differential that run .build/reference/ffmpeg and compare bytes, PCM or framecrc exactly, following existing tests in the same area. Options outside the implemented scope must fail explicitly before any output is written. Never claim more than your tests show.
- Match the surrounding code style exactly: dense lines, terse names, bigint timestamps, explicit resource limits, AbortSignal. Do not use Node built-ins in packages that run on Workers. Respect tools/package-boundaries.
- Edit only the files you own and the listed shared one-line edits. Do not refactor shared code. If your capability turns out to need any other shared edit, do not make it. Record the need in the report's notes and in your final message, and implement only what fits without it, refusing the rest explicitly.
- Do not edit docs/contributing/development-status.md, compat/capabilities.json, compat/implementation-progress.json or compat/test-contracts.json; the merge stage updates them. Do add the docs file listed in your owned files (docs/contributing/...md), describing the scope, the evidence and what remains unsupported.
- Write a machine-readable report to docs/contributing/wave1/fmt-hash-muxers.json with these fields: capabilityId, slug, status ("complete" or "partial" or "blocked"), filesChanged, sharedEdits, tests (file, test title and pass/fail count), nativeComparisons (count and what they compare), unsupported, linuxReferenceSha256, baselineUnitFailures, finalUnitFailures, proposedContracts (each with id, file, the exact test title as name, modes and scope) and notes.
- Your branch must change only your owned files and your listed shared one-line edits. Check with `git diff --name-only origin/prep/registries...HEAD` before pushing. Squash your work into one commit.
- This sandbox has 4 CPUs. Do not run the full workers, integration or differential suites. Run your own tests plus `npm run typecheck`, `npm run lint`, `npm run boundaries` and `npx vitest run tests/unit`. Any unit failures must be exactly the baseline ones.
- Commit to `wave1/fmt-hash-muxers` and push only that branch: `git push -u origin wave1/fmt-hash-muxers`. Do not open a PR, do not merge, and do not push any other branch. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- If you cannot finish, commit and push whatever is working, set status to "partial" or "blocked" in the report, and explain why.

## Final message
Report the branch, the final commit SHA, the status, the files you changed (mark shared ones), your tests and their counts, the native comparisons, the unsupported scope, the setup durations and any environment problems.
