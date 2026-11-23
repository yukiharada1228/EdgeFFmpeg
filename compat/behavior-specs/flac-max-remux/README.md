# Pinned Native FLAC remux evidence

This development-only corpus characterizes `-c:a copy -f flac`; it is not a production implementation or a conformance claim. The complete 22-chapter architecture target remains unchanged.

Run from repository root:

    node tools/differential-runner/flac-max-remux/generate.mjs --verify
    node tools/differential-runner/flac-max-remux/verify.mjs

Generation requires the existing pinned Native binary and FLAC Wasm artifact; it never builds, downloads, installs, imports production helpers, or executes Wasm. Matching fingerprints validate and reuse existing evidence with zero Native calls. The fingerprint includes the generator source, plans, input hashes, and binary/Wasm hashes. Verification never regenerates missing or mismatched evidence.

## Capture identity and provenance

The corpus records the full existing build metadata, Native SHA256 `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`, upstream commit, and actual Wasm SHA256. Native is a darwin/arm64 development oracle, not the Workers runtime. The ffprobe binary hash is checked for provenance but the accepted generator does not launch ffprobe.

All clean FLAC audio is reused byte-for-byte from `compat/behavior-specs/flac-decode-cli/cases.json`, choosing its `/s32le` rows only as a canonical input source. Their decoded output is not imported. Source path, row ID, and input SHA256 accompany each row. The tagged derivative preserves canonical STREAMINFO and every compressed audio byte, replacing other metadata with a documented Vorbis comment block. It requires no Native encoder or invented compressed payload.

There are 28 rows: the nine 16/24/32-bit stereo empty/ramp/extremes sources, each with default and bitexact/stripped metadata; two short-read caps; three packet limits; two overwrite policies; duplicate audio selection; and tagged default/stripped remuxes. Every row includes exact input/output bytes and hashes, equivalent isolated virtual argv using `/in.flac` and `/out`, exit code, normalized stderr, selected stream IDs, and descriptor metadata.

To conserve the shared Native call budget, 25 non-conflicting rows were captured in one multi-input/multi-output Native invocation. `capture.groupedArgv` records its actual argv with only transient root normalization; `capture.groupedRowIds` identifies those rows. Each output explicitly maps its own source metadata unless stripping is requested. Grouped rows share process exit status and stderr; their row argv is an equivalent isolated command, not a claim of separate execution. The overwrite and duplicate-stream cases were captured separately, yielding four sequential Native invocations in the accepted capture. Input/output payloads are bounded individually at 512 KiB, subprocess diagnostic buffers at 512 KiB, execution at ten seconds per call. Transient files live under `.build/temp/flac-max-remux-*` and are removed in `finally`; the final JSON is atomically renamed into place.

## Separate comparison dimensions

`exactBytes` compares the entire container to its source and to the default Native output. Metadata vendor strings, encoder tags, padding, and block ordering can differ while packet payloads remain unchanged.

`semanticPackets` separately compares packet payload SHA256/length sequences and complete interpreted packet fields, and reports whether the result is an input prefix. `inputMetadata` and `outputMetadata` expose block hashes, vendor/comments, and audio-region hashes. `inputPackets` and `outputProbe.packets` contain independent fixture-analysis results, NOT ffprobe output despite the historical `outputProbe` field name. Frame boundaries are determined from valid header CRC8 and complete-frame CRC16; clean-source timestamps are cumulative sample counts. STREAMINFO supplies descriptors. This is not a general FLAC parser and does not independently decode PCM. No production FLAC parser/muxer is imported.

## Observations retained without normalization

- Full copies, short reads capped to one/seven bytes, and a two-packet limit preserve all compressed packets. Canonical nonempty sources have two packets.
- Limits zero and one preserve respectively zero packets and the first packet. These are reported as packet differences, not hidden failures. STREAMINFO can retain the source sample total after packet truncation; the recorded bytes are authoritative.
- Default tagged output preserves TITLE and ARTIST and writes Native encoder metadata. Bitexact plus stripped mapping produces vendor `ffmpeg` and no user comments.
- `-y` replaces the sentinel with exactly the default remux output.
- This pinned Native binary returns exit code ZERO for `-n` on an existing output while printing an already-exists diagnostic and preserving the sentinel. This is an observed refusal, not successful media publication. `output` records the surviving exact sentinel, not generated FLAC; semantic comparisons are null.
- Duplicate audio mapping returns exit code 234 with “Exactly one FLAC audio stream is required.” Its actual output artifact, if any, remains recorded.

An earlier discarded generator execution used per-row ffprobe observations and stopped when the zero-exit overwrite refusal left a non-FLAC sentinel. It produced no accepted corpus. The accepted generator handles publication separately from exit status and uses an independent CRC-checked packet analysis to avoid rerunning identical probe data. Do not treat its accepted-capture counter as a count of all exploratory calls in the session.

## Remaining scope

No production helper, backend, shared exports, tests, contracts, or architecture documents were edited. Production currently accepts only the existing FLAC framecrc-copy route; Native FLAC remux evidence does not add its missing FLAC output route. Coordinator integration and focused differential tests against the eventual Workers TypeScript/Wasm remux path remain necessary, including Core ownership/reservations, bounded provider reads/writes, abort-aware waits and late rejection observation, cleanup, and atomic output publication. Native file protocol `blocksize` is a real short-read cap, not a Workers short-read/cancellation test. Pictures, malformed/truncated frames, arbitrary channel layouts, general timestamp/seek behavior, non-seekable output, PCM decoding, and broader 22-chapter compatibility are not established by this corpus.
