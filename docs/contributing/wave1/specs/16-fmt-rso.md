You are one of 40 cloud agents implementing EdgeFFmpeg capabilities in parallel. EdgeFFmpeg (https://github.com/yukiharada1228/EdgeFFmpeg) reimplements FFmpeg 9.0.2 in TypeScript for Cloudflare Workers. Your capability is `demuxer.rso`: Lego Mindstorms RSO demux + mux (also muxer.rso). Your branch is `wave1/fmt-rso`.

## Capability specification
- Upstream source: upstream/ffmpeg/libavformat/rsodec.c, rsoenc.c, rso.c, pcm.c
- Scope: Demux:
- pcm_u8 mono only (tag 0x0100). Tag 0x0101 (adpcm_ima_wav) is refused with native's PATCHWELCOME.
- Native has no read_probe and detects only by the .rso extension. Use the registry's extension-detection hook if prep provides one; otherwise support -f rso only, and fail explicitly when the format is undeclared.
- The header size is informational: data is read to EOF.
Mux:
- Default codec pcm_u8; other codecs are refused.
- Mono only, rate < 65536; otherwise refuse with native's INVALIDDATA (exit 183), before output creation.
- The size field is written up front from sampleCount as min(dataBytes, 0xffff), matching native's seekable trailer and its >64 KiB warning path.
- Output extension .rso.
- Files you own: packages/containers/src/rso.ts, packages/containers/NOTICE-RSO, docs/contributing/rso-support.md, tests/unit/rso.test.ts, tests/differential/rso.test.ts, docs/contributing/wave1/fmt-rso.json
- Shared one-line edits you may make: container format registry: +1 registration line (declared or extension demux, mux, .rso output extension); packages/containers/src/index.ts: +1 export line only if the recipe requires it
- Test strategy: Mux:
- rates {8000, 11025, 65535} x lengths {0, 1, 4097, 65535, 65536, 70000 bytes} from WAV/raw inputs, byte-compared with native written to a seekable file.
- Refusals with native exit codes: rate 65536/70000, stereo, -c:a pcm_s16le.
Demux:
- Native-written files, plus synthetic files whose header size is shorter or longer than the data.
- Through copy framecrc, WAV decode and -ss/-t.
FAT lavf-rso is an exact reference.
- Determinism notes: Integer only.
- Registry notes (these override any conflicting wording above): none

## Registry recipe for your area
To add container format <name> (its native -f name), create packages/containers/src/<name>.ts, or the path your ownedFiles give (the hash muxers use packages/containers/src/hash/hash-mux.ts). Start it with // SPDX-License-Identifier: LGPL-2.1-or-later and a line pointing to NOTICE-<FORMAT>. Keep in the module: open<Name>, which reads the header with bounded reads (at most maxReadBytes per read, signal checked around every await) and returns openRawPcm(<data range>,{codec,channels,sampleRate,channelMask,maxReadBytes,signal}), or its own packets(startSample,maxPacketBytes) for packed data such as sds; validate<Name>Output; mux<Name>, which writes the header in maxWriteBytes chunks and passes the payload to muxRawPcm through a wrapping writer so abort happens once; a private error class; and private codec, tag or line-reader tables. End it with export const <name>=defineContainer({name:'<name>',demux:{probe:{precedence,head,confirm?} or extensions:['.ext'],headerBytes,open,packetSpan?,seekBeyondEnd?},mux:{label,order?,extensions?,defaultCodec,supports,refuse?,options?,scratchBytes,dropsMetadata?,validate?,write}}). Omit mux for demux-only formats and demux for output-only formats. An exact magic uses precedence 100; head tests only the first four bytes, and confirm reads only what native read_probe reads. A format without read_probe uses demux.extensions (rso) instead of a probe. open receives {maxReadBytes,signal,declared,seek}: refuse unmirrored seeks there (wve), and set info.metadata=true on files whose native demuxer exports tags; the backend then refuses wav, aiff and au outputs unless the muxer sets dropsMetadata. packetSpan(info) returns a fixed native span, such as sds's 60, 40 or 30. validate throws every refusal before the output exists; use containerRefusal(message,234) or containerRefusal(message,183) to carry native's exit status. options:['-hash'] declares a per-format option, but the CLI parser still refuses -hash, so keep it refused unless your task says otherwise. Register the format with one line, export {<name>} from './<name>.js';, at its alphabetical position in packages/containers/src/registry.ts, using one line per name for a multi-name module (export {md5} from './hash/hash-mux.js';). The file is merge=union, and detection does not depend on line order. Make no barrel, detect.ts, avformat, framecrc.ts, raw-pcm.ts or PcmCodec edit. Create packages/containers/NOTICE-<FORMAT> (the four hash muxers share NOTICE-HASH) in the layout of NOTICE-W64: the upstream files, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8, the copyright lines, LGPL-2.1-or-later and COPYING.LGPLv2.1. Write tests/unit/<name>.test.ts covering header parsing, bounded reads, refusals, abort and the descriptor fields. Write tests/differential/<name>.test.ts with inputs synthesized in the test, native run at test time, and native exit codes compared for refusals. Also write docs/contributing/<name>-support.md and docs/contributing/wave1/<slug>.json, using your ownedFiles names. Limits: PCM codecs only, one stream, known sizes, and FLAC input never reaches registered muxers. Run your unit and differential files, tests/unit/container-registry.test.ts and tests/unit/container-registry-extension.test.ts (both unchanged), npm run typecheck, npm run lint and npm run boundaries. The full guide is docs/contributing/container-registry.md, section 'Adding a PCM-style container'; its xyz template compiles as written.

## Setup (record durations)
1. `git fetch origin prep/registries && git checkout -B wave1/fmt-rso origin/prep/registries`
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
- Write a machine-readable report to docs/contributing/wave1/fmt-rso.json with these fields: capabilityId, slug, status ("complete" or "partial" or "blocked"), filesChanged, sharedEdits, tests (file, test title and pass/fail count), nativeComparisons (count and what they compare), unsupported, linuxReferenceSha256, baselineUnitFailures, finalUnitFailures, proposedContracts (each with id, file, the exact test title as name, modes and scope) and notes.
- Your branch must change only your owned files and your listed shared one-line edits. Check with `git diff --name-only origin/prep/registries...HEAD` before pushing. Squash your work into one commit.
- This sandbox has 4 CPUs. Do not run the full workers, integration or differential suites. Run your own tests plus `npm run typecheck`, `npm run lint`, `npm run boundaries` and `npx vitest run tests/unit`. Any unit failures must be exactly the baseline ones.
- Commit to `wave1/fmt-rso` and push only that branch: `git push -u origin wave1/fmt-rso`. Do not open a PR, do not merge, and do not push any other branch. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- If you cannot finish, commit and push whatever is working, set status to "partial" or "blocked" in the report, and explain why.

## Final message
Report the branch, the final commit SHA, the status, the files you changed (mark shared ones), your tests and their counts, the native comparisons, the unsupported scope, the setup durations and any environment problems.
