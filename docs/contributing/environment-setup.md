# Environment setup

A fresh clone cannot run `npm run check`, or the Workers, integration and
differential suites, until several git-ignored inputs exist. `npm run bootstrap`
creates all of them from pinned inputs, verifies every hash the repository pins,
and does nothing when they are already present and verified.

```sh
git clone --branch feat/initial-implementation <repository> EdgeFFmpeg
cd EdgeFFmpeg
npm run bootstrap        # runs npm ci itself when node_modules is missing or stale
npm run check
```

`npm run bootstrap:check` reports each artifact as `ok`, `missing`, `mismatch`
and so on. It builds nothing, downloads nothing and exits non-zero when
anything is not ready.

## Prerequisites

- A host with an entry in `compat/reference-pins.json`: macOS arm64 with Apple
  clang 21.0.0 (`ffmpeg` `1b86106f…ab92`), or Linux x86_64 in the pinned
  container image (`ffmpeg` `5e43da9a…8c91`). Tests resolve the local reference
  to the pin for its own platform and fail when it matches none. Other hosts can
  bootstrap, but those tests fail there. See [Host limits](#host-limits) and
  [Linux reference](linux-reference.md).
- Node.js 24+ and npm.
- Git, a C compiler (`cc`) and Make for the reference and the oracles that tests
  compile at run time.
- Bash, Python 3, CMake and `tar` with xz support for the two Wasm codecs.
- About 5 GB of free disk space: the FFmpeg build tree is about 160 MB, the FLAC
  build copies the roughly 600 MB Emscripten cache into `.build/codecs/flac/cache`,
  and a new emsdk needs about 1.9 GB.
- Network access only when nothing local is reused: the FFmpeg submodule, the
  emsdk checkout and SDK, the OpenH264 commit, the libFLAC archive and the npm
  registry.

## What the bootstrap produces

The steps run in this order. Each one verifies first, builds only if
verification fails, then verifies again.

| Step | Output | Produced by | Verified against |
| --- | --- | --- | --- |
| `npm` | `node_modules/` | `npm ci` | every non-optional `package-lock.json` entry is installed at its locked version |
| `submodule` | `upstream/ffmpeg` | `git submodule update` (shallow from a URL, a full local clone from a local path) | the superproject gitlink and `compat/upstream.lock.json` commit; the tree is clean; `git describe --tags --always` gives `n9.0.2` |
| `reference` | `.build/reference/` (binaries, static libraries, headers, `ffbuild/config.mak`) | `tools/upstream-build/build.mjs` (`npm run reference:build`) | `build-metadata.json` matches the binaries, commit, flags and host; the six static libraries are present; the `platforms.<host>` pin in `compat/reference-pins.json` (named by `tools/bootstrap/lock.json`) |
| `openh264` | `.build/codecs/openh264/openh264.wasm` | `tools/codecs/openh264/build.mjs` | `expectedWasmSha256` in `tools/codecs/openh264/build.lock.json` |
| `flac` | `.build/codecs/flac/edge-flac.wasm` | `tools/codecs/flac/build.py` | `wasmSha256` and `wasmBytes` in `tools/codecs/flac/inputs.json` |
| `flac-investigation` | `.build/flac-investigation/native-cases.json`, `native-error-cases.json`, `malformed-prototype-result.json` | generators in `tools/bootstrap/flac-investigation/`, run against the verified reference and FLAC module | see [FLAC investigation evidence](#flac-investigation-evidence) |

The step that verifies the submodule also checks for the release tag. FFmpeg's
`ffbuild/version.sh` uses `git describe` for the version string it embeds. A
shallow checkout without the `n9.0.2` tag would embed the abbreviated commit
hash, and so produce a different binary. When the tag is missing, the bootstrap
fetches only that tag.

Which suites need which outputs:

- `npm run check` (unit tests) reads `upstream/ffmpeg` (`fate.test.js`, MP4
  tests), `edge-flac.wasm` (five files) and `native-cases.json` (two files).
  `native-cases.json` is generated from the reference, so `npm run check` needs
  the full reference build.
- Integration and differential tests run `.build/reference/ffmpeg` and
  `ffprobe`. `flac-decoder-native.test.ts` reads all three FLAC investigation
  files.
- Workers tests read both Wasm modules and the FLAC investigation corpus. The
  `hermes-max` API notes they also read are tracked fixtures in
  `tests/fixtures/hermes-max/api/`.
- Tests also compile some outputs themselves. `.build/oracles/*` (through
  `tools/differential-runner/build-oracle.mjs`), `.build/aac-native-probe/` and
  `.build/cli-launcher/` are built from `cc`, the reference's static libraries
  and the submodule sources. The bootstrap does not prebuild them.

## Reuse and offline options

Pass options after `--`, for example `npm run bootstrap -- --offline --emsdk ~/emsdk`.
Relative paths are resolved from the directory you ran npm from.

| Option | Effect |
| --- | --- |
| `--emsdk <dir>` | Use an existing emsdk checkout instead of `.build/toolchains/emsdk`. It must be its own checkout at the pinned commit `708dcbcc…`, unmodified, with Emscripten 7.0.0 installed. `emcc --version` must match `tools/codecs/flac/evidence/compiler.txt`. It is activated if it is not active yet, and never installed or updated. |
| `--ffmpeg-source <git dir or URL>` | Where the submodule is cloned from. A local path, such as another checkout's `upstream/ffmpeg`, gives a full clone in a few seconds and needs no network. A URL gives a shallow clone. The submodule's recorded URL is restored to `.gitmodules` afterwards. |
| `--openh264-source <git dir or URL>` | Any repository that contains OpenH264 commit `1bca6231…`. A previous build's `.build/codecs/openh264/source` works even though its tree is patched, because only the commit is fetched into a clean `.build/vendor/openh264`. |
| `--flac-archive <file>` | A local `flac-1.5.0.tar.xz`. It is checked against `archiveSha256` before it is copied to `.build/vendor/`. |
| `--offline` | Never download. A step that would need the network fails before it contacts anything, and the message names the option that avoids the download. `npm ci` runs with `--offline`, so it uses only the npm cache. |
| `--only <step,...>` | Run only the listed steps. The other steps are still verified and reported. A selected step whose dependency is not ready fails. |
| `--allow-unpinned-reference` | Accept a consistent reference whose hashes differ from this host's pin, for example a different compiler version. Without this option a mismatching reference is rebuilt, and the run fails if the rebuilt binaries still mismatch. Tests that pin the reference then fail. |
| `--check` | Report only (`npm run bootstrap:check`). |

Without these options the bootstrap downloads only from pinned locations:

- the `.gitmodules` URL at the locked commit and tag;
- `https://github.com/emscripten-core/emsdk.git` at the pinned commit, followed
  by `emsdk install 7.0.0` and `emsdk activate 7.0.0`, as CI does;
- `https://github.com/cisco/openh264.git` at the pinned commit;
- `https://downloads.xiph.org/releases/flac/flac-1.5.0.tar.xz`, checked against
  the pinned SHA-256 before it is written.

Git checkouts are identified by commit hash. emsdk does not checksum the SDK
archives it downloads. The toolchain is checked only indirectly: its `emcc`
version string must match, and both codec builds must reproduce their pinned
Wasm hashes, or they fail.

The bootstrap never deletes something it cannot rebuild. An output directory
that exists but fails verification is moved to `.build/bootstrap/stale/<time>/`
before it is rebuilt. The exception is the extracted `.build/vendor/flac-1.5.0`,
which is extracted again from the verified archive. The bootstrap refuses to
touch a submodule that has local changes or sits at another commit. Each build
step writes its full log to `.build/bootstrap/logs/<step>.log`. Each run records
step results and durations in `.build/bootstrap/last-run.json`. A lock
directory, `.build/bootstrap/run.lock`, stops two bootstraps from running in one
checkout at the same time. Do not run it while other processes use that
checkout's `node_modules`, because a stale install is replaced with `npm ci`.

## FLAC investigation evidence

No tracked file generated these three files. They came from untracked scripts
in an earlier investigation. `tools/bootstrap/flac-investigation/` holds
byte-identical copies of those scripts, and their hashes are pinned in
`tools/bootstrap/lock.json`. The bootstrap stages them at their original
`.build/flac-investigation/` paths in a scratch directory and runs them there,
so the `generatorSha256` and `adapterSha256` values recorded inside the outputs
remain true. It then installs the outputs.

- `native-cases.json` is reproduced byte for byte against the pinned reference.
  Its SHA-256 `27b76ec8…` is also the `sourceSha256` recorded by
  `compat/behavior-specs/flac-decode-workers`, `flac-comments` and
  `flac-metadata`.
- `native-error-cases.json` records native stderr, and that stderr contains heap
  addresses (`[flac @ 0x…]`) that change on every run. Its byte hash therefore
  cannot be reproduced. The bootstrap pins the hash of the content with those
  addresses masked. It also checks that `sourceSha256` is the hash of
  `native-cases.json` and that the embedded reference is the current one.
- `malformed-prototype-result.json` is the earlier prototype adapter's result on
  those inputs, with the same `edge-flac.wasm` (`d5f5015f…`). Everything except
  its `oracleSha256` is pinned. `oracleSha256` must equal the hash of the
  regenerated `native-error-cases.json`, which is what
  `tests/integration/flac-decoder-native.test.ts` checks.

The generator that produced the existing `native-error-cases.json` is the
investigation's `generate-error-cases-initial.mjs`. Its hash matches the
recorded `generatorSha256`. The later, edited `generate-error-cases.mjs` does
not.

The tests load these files through `tests/helpers/flac-investigation.ts`. A
missing file fails with `Missing generated input … run npm run bootstrap -- --only
flac-investigation`. Loading also checks that the embedded reference is the local
binary and the pin for this platform, that both generators and the prototype
adapter are the `lock.json` pins and that the three files link by hash. The
malformed-input divergence counts in `flac-decoder-native.test.ts` are recorded
per pinned reference; a platform without an entry fails rather than reusing
another platform's counts.

The `hermes-max` API notes are hand-written descriptions of FLAC helper modules
from an earlier agent run. They have no generator and are not Native evidence,
so they are tracked test fixtures in `tests/fixtures/hermes-max/api/`, byte for
byte the files the bootstrap's former `seeds` step installed.

## Measured durations

Measured on 2026-11-24 on macOS arm64 (Apple clang 21.0.0, Node 24.12.0). Other
agents were building on the same machine at the time, with a load average of 10
to 18. The checkout was a fresh `git clone` of `feat/initial-implementation`
with the bootstrap files overlaid, bootstrapped with
`--offline --emsdk <existing emsdk> --ffmpeg-source <existing upstream/ffmpeg> --openh264-source <existing OpenH264 checkout> --flac-archive <cached archive>`:

| Phase | Wall time | Result |
| --- | --- | --- |
| `git clone` (local path) | 4.1 s | |
| `npm` step (`npm ci --offline`) | 8.9 s | 218 locked packages |
| `submodule` step (full local clone) | 2.9 s | `946fcce07b6d` (`n9.0.2`) |
| `reference` step (configure + `make`, up to 8 jobs) | 147.7 s | `ffmpeg` `1b86106f…`, `ffprobe` `9cb672fd…`: both equal the darwin-arm64 pin |
| `openh264` step | 28.8 s | `1b14bb76…`, equal to `build.lock.json` |
| `flac` step | 62.6 s | `d5f5015f…`, 69,607 bytes, equal to `inputs.json` |
| `flac-investigation` step | 4.9 s | `native-cases.json` `27b76ec8…`; the other two equal their masked pins |
| `seeds` step (since removed; the notes are tracked fixtures) | 0.0 s | 7 files |
| **`npm run bootstrap` total** | **256.8 s** | |
| `npm run check` | 119.0 s | 2,602/2,602 unit tests across 204 files |
| `npm run test:integration` | 1,789 s | 2,079/2,081 tests across 83 files; 2 hit 60 s test timeouts |
| `npm run test:workers` | 3,317 s | 266/277 tests across 110 files; 11 hit 60 s test timeouts |
| `npm run test:differential` | not run | stopped after 7 s to limit load on the shared machine |

The first `npm run check` attempt took 197.4 s. One file,
`tests/unit/media-job-executor.test.ts`, failed with a 10 s Miniflare
`beforeAll` timeout at a load average of about 15. That file reads no bootstrap
output. It passed 15/15 when run alone, and the full rerun above passed.

Every integration and Workers failure was a 60 s per-test `TestTimeoutError` in
a test that runs hundreds or thousands of native-compared jobs. The integration
failures were `video-flip` and `video-filter-numeric`. The Workers failures were
in `signed-video-time` (4), `video-copy-ts`, `mp4-negative-map`, `mp4-language`,
`simple-video-cli`, `video-streamcopy`, `video-option-order` and
`timed-video-backend`. None was a missing or mismatched input.

Run alone at a load average of 11 to 19, `video-filter-numeric` passed in 61.6 s.
`video-flip`, `mp4-negative-map` and `mp4-language` timed out again.
`mp4-negative-map` also timed out in the main working checkout under the same
load. The recorded sequential validation of this commit passed it (see
[development status](development-status.md)). These runs do not show that the
full suites pass from a fresh clone. Run them on an otherwise idle machine.

Single files that read the generated outputs:

| Command | Wall time | Result |
| --- | --- | --- |
| `npx vitest run tests/workers/flac-max-frames.test.ts --maxWorkers=1` | 7.9 s | 1/1 |
| `npx vitest run tests/workers/h264.test.ts --maxWorkers=1` | 4.2 s | 1/1 |
| `npx vitest run tests/integration/flac-decoder-native.test.ts --maxWorkers=1` | 2.3 s | 80/80 |
| `npx vitest run tests/differential/h264.test.ts --maxWorkers=1 --testTimeout=30000` | 9.1 s | 1/1, compiles the `h264-frames` oracle |
| `npx vitest run tests/differential/w64.test.ts --maxWorkers=1 --testTimeout=30000` | 33.2 s | 3/3 |
| `npx vitest run tests/differential/expression.test.ts --maxWorkers=1 --testTimeout=30000` | 6.1 s | 3/3, compiles two oracles |

A second `npm run bootstrap` in the same clone verified everything without
building in 0.7 s with the reuse options and 0.4 s without them. `npm run
bootstrap:check` took 0.9 s. To recover, a run moved a corrupted seed and the
directory of a deleted `openh264.wasm` to `.build/bootstrap/stale/`. Offline, it
then rebuilt OpenH264 from the existing `.build/vendor/openh264` checkout,
regenerated the deleted FLAC investigation files and matched every pin, in
85.0 s. A bootstrap without reuse options would also download FFmpeg (shallow),
the emsdk SDK (about 1.9 GB installed), OpenH264 and libFLAC. Those downloads
were not measured.

## Running tests

Run whole suites with `npm run check`, `npm run test:integration`,
`npm run test:differential` and `npm run test:workers`. To run a single file:

```sh
npx vitest run tests/unit/flac-decoder.test.ts --maxWorkers=1
npx vitest run tests/integration/flac-decoder-native.test.ts --maxWorkers=1
npx vitest run tests/differential/h264.test.ts --maxWorkers=1 --testTimeout=30000
npx vitest run tests/workers/flac-max-frames.test.ts --maxWorkers=1
```

`npm run test:workers -- <file>` runs the whole Workers suite, because the
script already passes `tests/workers` as a filter. Use `npx vitest run` with the
file path instead. `npm run test:differential` adds `--testTimeout=30000`; pass
it explicitly for single differential files.

## Host limits

- `compat/reference-pins.json` pins the macOS arm64 reference and the Linux
  x86_64 container build first recorded in
  `compat/behavior-specs/inverse-linux-x64.json`. No tool writes it.
  `compat/capabilities.json` cannot serve as a pin, because `compat:report`
  rewrites it with the host's build. On a host without a pin, a consistent
  reference is accepted only with `--allow-unpinned-reference`. On a host with a
  pin, a mismatch needs `--allow-unpinned-reference`, and tests that resolve the
  pinned reference then fail.
- The FLAC investigation outputs are content-pinned only for the macOS arm64
  reference so far. Against the Linux pin they are generated and their
  provenance links are verified; their Linux content pins are added from the
  first GitHub reference job that produces them.
- Reproducibility was verified on one macOS arm64 machine: a fresh clone rebuilt
  the reference with the pinned hashes. Other machines with the same Apple clang
  version, and Linux, are unverified.

## CI

`.github/workflows/ci.yml` keeps its explicit, pinned build steps: the
container image, OpenH264 and emsdk commits, Emscripten 7.0.0, and the libFLAC
URL and SHA-256. Every job runs in the pinned image and runs npm and the tests as
the image's unprivileged `node` user. The reference job fetches the `n9.0.2` tag
into the shallow submodule before `reference:build`, so FFmpeg embeds the same
version string as the pinned builds. After the codec builds it runs
`node tools/bootstrap/bootstrap.mjs --only flac-investigation` as `node`, without
`--allow-unpinned-reference`, so a reference that is not the linux-x64 pin fails
the job there. The three outputs are added to the `worker-reference-and-codec`
artifact. See [Linux reference](linux-reference.md) for the probe workflow and
the local container loop.
