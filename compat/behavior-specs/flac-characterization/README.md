# Pinned FLAC header, scoring, and intake characterization

Reference: FFmpeg 9.0.2 commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`.
Development-only C harness includes upstream `libavcodec/flac_parser.c`, copyright
(c) 2010 Michael Chinen, LGPL-2.1-or-later; it links the fixed `.build/reference`
static libraries. See `upstream/ffmpeg/COPYING.LGPLv2.1` and source notices.
Header expectations come directly from `ff_flac_decode_frame_header`, not the
EdgeFFmpeg header parser. Candidate validation independently uses the included
upstream `frame_header_is_valid`. The JS encoder only constructs inputs and CRC8;
it does not compute expected decoded fields, scores, links, or packet boundaries.

Regenerate sequentially with:

```
node tools/differential-runner/flac-characterization/generate.mjs
npx vitest run tests/differential/flac-characterization.test.ts --maxWorkers=1
npx tsc -p tools/differential-runner/flac-characterization/tsconfig.json --noEmit
```

The generator uses no production imports, installs, or unbounded subprocesses.
It checks the reference/source commit and records source, library, config,
compiler, executable and fixture hashes. `raw.json` retains each native stdout,
stderr, status, input hash, and mode arguments; `cases.json` retains all inputs
and parsed observations. Signed 64-bit timestamps remain decimal strings.
The executable is deleted after successful generation. The pinned upstream
compile emits two pointer-sign warnings and a duplicate `-lm` linker warning;
these do not replace or suppress native stderr observations.

Latest generation: 118 sequential native processes: 97 headers, 7 scoring
corpora, 10 public parser schedules, 2 internal parser schedules, and 2 AVIO
schedules. This does not repeat the earlier 86-case parser verification.
Targeted verification: 114 tests passed; isolated strict TypeScript check passed.

Coverage is finite: overlong 2–6 byte number encodings, maximum signed31 number,
FE/FF and invalid continuation bytes, every block/rate/bps/channel code,
explicit zero/max extensions, inherited rate/bps, variable blocking, CRC and
subframe corruption, and every proper prefix of a longest valid header.
Scoring graphs cover clean frames, CRC corruption, missing/duplicated/reordered
frames, false payload headers and a deterministic overlapping synthetic chain.
Each graph records fresh, retained, changed-last-header retained, changed-last-
header fresh, drained, and partial-append/rescore observations. Comparisons use
native-decoded descriptors and independently computed CRC16 prefixes, never
production header decoding to produce expected candidates.

The default public descriptor parser is compared on clean 7-byte and one-shot
intake, plus one-shot CRC-first and false-header mutations. Assertions include
consumed counts, signed internal raw indices (separate direct internal calls),
packet bytes, durations, frame/next/current offsets, repeated drain and EOF.
These finite malformed cases are evidence only; they do not resolve general
malformed policy differences. No production files or CRC policy were changed.
