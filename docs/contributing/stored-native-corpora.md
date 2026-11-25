# Stored Native corpora per platform

Fourteen stored Native corpora are recorded once per pinned reference and compared with Edge later. Their tests never
run Native for the expected values, so each platform needs its own recording. The pins and the shared corpus writer are
described in [linux-reference.md](linux-reference.md).

| Corpus (`compat/behavior-specs/…`) | Generator (`tools/differential-runner/…/generate.mjs`) | Files | Tests |
| --- | --- | --- | --- |
| `flac-aformat-constraints` | same name | `cases.json` | `tests/integration/flac-aformat-constraints.test.ts` |
| `flac-aformat-rate` | same name | `cases.json` | `tests/integration/flac-aformat-rate.test.ts` |
| `flac-max-combined` | same name (with `scalar.mjs`) | `cases.json`, `scalar.json` | `tests/integration/flac-max-combined.test.ts` |
| `flac-timed-aformat` | same name | `cases.json` | `tests/integration/flac-timed-aformat.test.ts` |
| `flac-timed-buffered` | same name | `cases.json` | `tests/integration/flac-timed-buffered.test.ts` |
| `flac-timed-filters` | same name | `cases.json` | `tests/integration/flac-timed-filters.test.ts` |
| `flac-timed-rate` | same name | `cases.json` | `tests/integration/flac-timed-rate.test.ts` |
| `reference-metadata` | same name | `cases.json` | `tests/differential/reference-metadata.test.ts` |
| `wav-channel-layout` | same name | `cases.json` | `tests/differential/wav-channel-layout.test.ts`, `tests/workers/wav-layout.test.ts` |
| `wav-channel-mask` | same name | `cases.json` | `tests/differential/wav-channel-mask.test.ts`, `tests/workers/wav-layout.test.ts` |
| `default-channel-layout` | same name | `cases.json`, `native-layouts.json` | `tests/differential/default-channel-layout.test.ts`, `tests/workers/default-channel-layout.test.ts` |
| `node-input-directory` | same name | `results.json` | `tests/differential/node-input-directory.test.ts` |
| `node-output-directory` | same name | `profiles.json`, `results.json` | `tests/differential/node-output-directory.test.ts` |
| `node-permissions` | same name | `profiles.json`, `results.json` | `tests/differential/node-permissions.test.ts` |

## Layout

- **darwin-arm64** keeps its tracked layout at the corpus base. The seven non-FLAC corpora keep `manifest.json` and
  `provenance.json` (`reference`, `sources`, counts and scope) beside the data files. Running a generator without
  arguments on macOS rewrites that layout in place; the cached FLAC generators extend `cases.json` from verified rows,
  and `--verify` executes nothing.
- **Every other pin** uses `<corpus>/<pin id>/`, written by the same generator through
  `tools/differential-runner/platform-corpus.mjs`: the data files above, the platform-corpus `manifest.json` and
  `provenance.json`, and for the non-FLAC corpora `sources.json`, which is the darwin `provenance.json` record without
  `reference` (the platform provenance holds `build-metadata.json` verbatim). Every row is recorded afresh, with no
  cached rows. `flac-max-combined` records its 18 explicit `-cpuflags 0` rows of `scalar.json` in the same run;
  `remux-policy.json` stays darwin-arm64 evidence.
- `--draft` (or `EDGEFFMPEG_CORPUS_DRAFT=1`) writes the platform layout under `.build/linux-green/drafts/` on any host.
  Committed linux-x64 corpora come only from the `corpora` job of the `Linux probe` workflow on real hardware.

Each generator has a `platform-corpus.json` descriptor, so `node tools/linux/generate-corpora.mjs` (the corpora job)
and `npm run linux:corpora -- --draft` (the local container) run all 14. The three node-* descriptors are
`unprivileged`: their statuses depend on POSIX permission and errno semantics, so they run as uid 1000 on a real Linux
filesystem (the container's tmpfs `/tmp`, never the virtiofs bind mount).

## Selection in tests

`tests/helpers/flac-native-corpus.ts` (the seven FLAC corpora) and `tests/helpers/native-corpus.ts` (the others)
return the corpus of the verified local reference (`pinnedReference()`), with no fallback. A missing platform corpus
fails with `Missing linux-x64 corpus <dir>; generate it with the linux-corpora job`. A platform corpus must verify
through `verifyPlatformCorpus` (manifest, not a draft, the corpora job on a real CPU in the pinned image, the local pin)
and must name the tracked generator by path and sha256. The darwin-arm64 corpus is also verified on every host as
darwin-arm64 evidence: its manifest, its sources, and that it records the darwin-arm64 pin. Its rows are never the
expected output on another platform.

Row ids, test names and every row and count assertion are the same on both platforms. The FLAC pin tests also check
that the selected rows record the local pin, that the darwin rows record the darwin-arm64 pin, and that both have the
same row ids. Outcome counts that differ by platform are tables keyed by pin id, with no fallback:
`DIRECTORY_OUTCOMES` (`tests/helpers/node-input-directory.ts`), `OUTPUT_DIRECTORY_OUTCOMES`
(`tests/helpers/node-output-directory.ts`) and `PERMISSION_OUTCOMES` (`tests/helpers/node-permissions.ts`). The
default-layout oracle must link the `libavutil/libavutil.a` pinned for the local reference.

## Generator self-hashes

The seven non-FLAC corpora record the sha256 of their own generator in `sources`, and the tests require it to match.
After the generators were parametrized, the darwin-arm64 corpora were regenerated on macOS (Apple M-series, the
darwin-arm64 pin). Every data file (`cases.json`, `results.json`, `profiles.json`, `native-layouts.json`) came out
byte-identical, as did the recorded reference, the oracle binary hash and the compiler. Only the generator hash in
`provenance.json`, and that file's entry in `manifest.json`, changed. Changing a generator again requires the same
regeneration on macOS and a new corpora-job run for linux-x64.

## linux-x64 provenance

All 14 `linux-x64/` directories are the `linux-x64-corpora` artifact of the `corpora` job of `Linux probe` run
45607125330 (branch `linux-probe/corpora`, commit `18ab1fc`), copied unchanged. Each `provenance.json` records the
linux-x64 pin (ffmpeg `5e43da9a…`, ffprobe `0895f870…`) and the reference build metadata, the tracked generator and its
sha256, the pinned `node` image digest, an Intel Xeon Platinum 8370C (not emulated), uid 1000, and the run id.
`tests/unit/platform-provenance.test.ts` verifies them on every host.

Local drafts from the pinned image under Rosetta (`npm run linux:corpora -- --draft`) were compared with the
artifact before it was committed. Every data file except the FLAC `cases.json` and `scalar.json` is byte-identical.
The FLAC files agree in every row id, argument, input, exit status and output byte; their stderr differs only in heap
addresses in log prefixes (`@ 0x…`), the `speed=` and `elapsed=` progress statistics, and, in 34
`flac-aformat-rate` rows run with `-loglevel verbose`, the order of the threads' termination messages.

## linux-x64 compared with darwin-arm64

Case ids, arguments and inputs are identical on both platforms. The recorded differences are:

- **FLAC.** In `flac-aformat-rate`, the four `aformat=sample_fmts=dblp` rows at 11025 Hz from the 24-bit source differ
  in output bytes, although they run with `-cpuflags 0` on both platforms. The likely cause, not yet confirmed from the
  objects, is floating-point contraction: Apple clang contracts C arithmetic into fused multiply-adds by default, and GCC
  for baseline x86-64 has no FMA. The test keeps these four rows as the explicit double-FIR precision gap, which Edge rejects before output on both
  platforms. In `flac-max-combined`, ten default-profile rows with `-ar` differ. darwin-arm64 takes its NEON paths by
  default, so 10 of its 18 default rows differ from their `-cpuflags 0` rows. linux-x64 (`--disable-x86asm`) has no
  SIMD path there, so all 18 of its default rows equal its `-cpuflags 0` rows.
  These are the explicit CPU-rounding gap rows that Edge rejects until `-cpuflags 0` is given. `scalar.json` is
  identical on both platforms. stdout and stderr differ only in the banner (compiler) and progress statistics.
- **node-output-directory.** The 156 trailing-slash create cases (`output-absent-slash` and `output-file-slash`
  without `-y -n` conflicts) fail with EISDIR, status 235 and `Is a directory`, on Linux, where macOS reports ENOENT
  (254) and ENOTDIR (236). Counts: darwin-arm64 `0:104, 235:52, 254:78, 236:208, 234:208`; linux-x64
  `0:104, 235:208, 236:130, 234:208`. The generator records the expected trailing-slash create outcome per pin and
  checks every Native status and reason against it. runtime-node classifies these paths with the same create-open
  ([node-filesystem.md](node-filesystem.md)).
- **No other difference.** `reference-metadata` (336), `wav-channel-layout` (72), `wav-channel-mask` (14),
  `default-channel-layout` (512 cases, 13 layouts), `node-input-directory` (1,932, histogram
  `0:548, 183:600, 234:520, 235:264`) and `node-permissions` (520, `243:234, 234:168, 0:118`) record the same
  rows on both platforms.
