# Linux reference and per-platform Native evidence

EdgeFFmpeg is compared with a Native FFmpeg 9.0.2 build. Two builds are pinned,
one per platform, and every comparison uses the pin of the platform it runs on.
Evidence recorded on macOS is never relabelled as Linux evidence, or the
reverse.

| Pin id | Host | `ffmpeg` | `ffprobe` | `libavutil.a` | First recorded in |
| --- | --- | --- | --- | --- | --- |
| `darwin-arm64` | macOS arm64, Apple clang 21.0.0 | `1b86106f…ab92` | `9cb672fd…7698` | `b8864b17…a598` | `compat/behavior-specs/mp4-demux/provenance.json` |
| `linux-x64` | `docker.io/library/node@sha256:9d266751…7496` (Debian 12, gcc 12.2.0, glibc 2.36) on x86_64 | `5e43da9a…8c91` | `0895f870…671b` | `b0f1b008…b4c1` | `compat/behavior-specs/inverse-linux-x64.json` |

Both are built from `n9.0.2` (`946fcce0…`) with `compat/configure.flags`.

## Pins: `compat/reference-pins.json`

```json
{"schemaVersion": 1, "commit": "…", "tag": "n9.0.2", "flags": ["…"],
 "platforms": {"<platform>-<arch>": {"platform": "…", "arch": "…",
   "artifacts": {"ffmpeg": "<sha256>", "ffprobe": "<sha256>"},
   "libraries": {"libavutil/libavutil.a": "<sha256>", "…": "…"},
   "librariesSource": "…", "compiler": "…", "image": "<digest, Linux only>", "source": "<tracked record>"}}}
```

No tool writes this file. `compat/capabilities.json` cannot serve as a pin,
because `npm run compat:report` rewrites it with whatever reference the host
built. `tools/bootstrap/lock.json` `reference.pins` names this file, and the
bootstrap reads `platforms.<host>` from it. `tests/unit/reference-identity.test.ts`
checks that the commit, tag and flags equal `compat/upstream.lock.json` and
`compat/configure.flags`, that each `source` record holds the same binaries, and
that the Linux image equals `compat/reference-container.lock.json` and every
image in the workflows.

The library hashes are those of a build whose programs equal the pin. For
`darwin-arm64` they reproduce the link-input digest pinned in
`tools/bootstrap/lock.json`. For `linux-x64` they come from the local container
build in `.build/linux-x64/reference`; the GitHub reference job must reproduce
them.

## Reference identity for tests: `tests/helpers/reference-identity.ts`

This interface is fixed. Tests that compare with the local reference, or with a
stored corpus recorded from a reference, use it instead of hash literals. The
rules live in `tools/differential-runner/reference-identity.mjs` (typed by
`reference-identity.d.mts`), which generators and tools share.

| Function | Result |
| --- | --- |
| `pinnedReference()` | `{id, platform, arch, ffmpeg, ffprobe, libraries, metadata, pin}` for `.build/reference`, cached per test file. It throws unless `build-metadata.json` records the `compat/upstream.lock.json` commit and `compat/configure.flags`, its platform and arch are this host's, `ffmpeg` and `ffprobe` hash to the values in `build-metadata.json`, and both equal the pin for that platform. Errors read, for example, `Reference linux-x64 ffmpeg 58295ca5… is not the pinned 5e43da9a… (compat/reference-pins.json)` or `No pinned Native reference for linux-arm64 (compat/reference-pins.json)`. |
| `resolvePinnedReference(inputs)` | The same rules over injected inputs, for unit tests. |
| `referencePin(id)`, `referencePinIds()` | One pin, read-only, and the pinned ids. For platform-independent checks of tracked evidence, for example that a darwin corpus still names `referencePin('darwin-arm64').artifacts.ffmpeg`. |
| `verifyPinnedLibrary(path)` | The sha256 of `.build/reference/<path>` after checking it equals `pinnedReference().libraries[path]`. |
| `platformCorpusDir(base, id?)` | `base` for `darwin-arm64`, `base/linux-x64` for `linux-x64`; any other id throws. There is no fallback. |
| `readPlatformCorpus(base, file, id?)` | `<platformCorpusDir(base)>/<file>` as JSON. A non-darwin corpus is verified first with `verifyPlatformCorpus`. A missing Linux corpus throws `Missing linux-x64 corpus …; generate it with the linux-corpora job (docs/contributing/linux-reference.md)`. |
| `verifyPlatformCorpus(base, id?)` | Verifies a `<base>/<id>/` corpus: its manifest covers exactly the files present and their hashes, its provenance is not a draft and names the pin, and for the local id the local binaries. Returns the provenance. Not for `darwin-arm64`, whose corpora keep their own checks. |
| `assertCorpusReference(recorded)` | A recorded reference (`{platform, arch, artifacts}`, or a platform-corpus provenance) names the verified local pin: platform, arch and `ffmpeg` (and `ffprobe` when recorded) equal both the pin and the local hashes. Returns `pinnedReference()`. |
| `assertRecordedPin(recorded, id)` | The same check against pin `id`, without the local reference. |
| `requireGeneratedInput(path, how)` | The bytes of a git-ignored generated input, or `Missing generated input <path>; run <how>`. |

`tests/helpers/flac-investigation.ts` builds on it for the bootstrap's FLAC
investigation files.

Pixel arithmetic stays in `tests/helpers/reference-pixel-profile.ts`, which
selects a profile from the same verified build metadata.

## Per-platform corpora

A stored corpus is Native output recorded once and compared with Edge later.
Corpora recorded on macOS stay where they are, byte for byte. Linux corpora go
in `<corpus>/linux-x64/`:

```text
compat/behavior-specs/<corpus>/            darwin-arm64 corpus, unchanged
compat/behavior-specs/<corpus>/linux-x64/  <outputs>, manifest.json, provenance.json
```

Generators write them through `tools/differential-runner/platform-corpus.mjs`:

```js
import {corpusTarget, writePlatformCorpus} from '../platform-corpus.mjs';
const target = corpusTarget('compat/behavior-specs/<corpus>', 'tools/differential-runner/<id>/generate.mjs');
// ... run the pinned reference ...
writePlatformCorpus(target, {'cases.json': rows});
```

`corpusTarget` resolves the local reference with the same rules as the tests and
refuses an unpinned one. It refuses to write committed evidence:

- on an emulated CPU (`/proc/cpuinfo` reports VirtualApple or QEMU);
- for a non-darwin pin, outside a GitHub Actions run, or when
  `EDGEFFMPEG_CONTAINER_IMAGE` does not name the pinned image.

With `--draft` (or `EDGEFFMPEG_CORPUS_DRAFT=1`) it writes under
`.build/linux-green/drafts/<corpus path>/` instead. `writePlatformCorpus`
writes the outputs, `manifest.json` (sha256 of every file) and `provenance.json`
atomically, and refuses the darwin tracked layout. The provenance
(`edge-ffmpeg/platform-corpus@1`) records:

- `referenceId` and the pin (`ffmpeg`, `ffprobe`, `source`, `image`);
- `reference`: `build-metadata.json` verbatim;
- `generator`: path and sha256;
- `image`: the image the job ran in;
- `environment`: platform, arch, Node, kernel, CPU model, `emulated`, uid;
- `ci`: GitHub repository, workflow, job, run id, attempt and commit;
- `draft` and `generatedAt`.

`tests/unit/platform-provenance.test.ts` checks every tracked record:

- every `{platform, arch, artifacts}` reference record under
  `compat/behavior-specs` names that platform's pin;
- every `<corpus>/<pin id>/` directory verifies, was recorded on a real CPU by a
  CI run in the pinned image, and names no other platform's binaries;
- the darwin files beside it name no Linux binary.

A Linux run therefore cannot pass against macOS data, or the reverse.

### Descriptors and the corpora job

Each generator that writes per-platform corpora adds
`tools/differential-runner/<id>/platform-corpus.json`:

```json
{"schemaVersion": 1, "base": "compat/behavior-specs/<corpus>",
 "generate": "tools/differential-runner/<id>/generate.mjs",
 "oracle": ["<build-oracle.mjs name>"], "unprivileged": true, "outputs": ["cases.json"]}
```

`node tools/linux/generate-corpora.mjs [--draft] [--only <id,...>|all] [--list]`
builds each listed oracle with `build-oracle.mjs`, runs the generator, and checks
that it wrote exactly the declared outputs with a verified manifest and
provenance. `unprivileged` descriptors refuse uid 0. It writes a summary to
`.build/linux-corpora/summary.json`, and fails explicitly when no descriptor
exists or one fails.

Committed Linux corpora come only from the `corpora` job of the probe workflow,
on GitHub's x86_64 hardware. Download its `linux-x64-corpora` artifact, compare
it with your local drafts, review it, and commit it.

## CI: `.github/workflows/ci.yml`

- Runs on pushes, except to `linux-probe/**` branches, and on pull requests.
- Every job runs in the pinned image. Steps run as root, so each job runs
  `chown -R node:node "$GITHUB_WORKSPACE"` and then runs npm and the tests as
  the image's `node` user (uid 1000) with `runuser`. The permission tests refuse
  to run as root.
- The reference job fetches the `n9.0.2` tag into the shallow submodule and
  checks that `git describe` gives `n9.0.2` before `reference:build`. Without
  the tag, FFmpeg's `version.sh` embeds the abbreviated commit and the binaries
  differ from the linux-x64 pin only in that string.
- After the codec builds, it runs
  `node tools/bootstrap/bootstrap.mjs --only flac-investigation` as `node`. This
  fails the job when the reference is not the linux-x64 pin. The three outputs
  are added to the `worker-reference-and-codec` artifact. On failure,
  `reference-diagnostics` uploads `.build/reference/` and `.build/bootstrap/`
  for comparison with `.build/linux-x64/reference`.
- `npm run compat:report` runs as `node`.

The FLAC investigation outputs have no Linux content pins in
`tools/bootstrap/lock.json` yet, and `flac-decoder-native.test.ts` has no Linux
malformed-divergence counts. Both are added from the first reference job that
produces them, and the counts must equal the local container drafts.

## Probe workflow: `.github/workflows/linux-probe.yml`

A push to a `linux-probe/**` branch runs selected tests, or regenerates corpora,
on real x86_64 hardware in the pinned image, in about 5 to 10 minutes plus the
tests. The branch commits `.github/linux-probe.json`:

```json
{"tests": ["tests/differential/node-permissions.test.ts"], "shards": 1, "corpora": ["node-permissions"]}
```

`corpora` is a list of descriptor ids or `"all"`. `node tools/linux/probe.mjs plan`
validates the file.

- `prepare` restores `.build/reference` and the two Wasm modules from the
  Actions cache. The key hashes `compat/upstream.lock.json`,
  `compat/configure.flags`, `compat/reference-container.lock.json`,
  `tools/upstream-build/build.mjs` and `tools/codecs/**`. On a miss it builds them
  as the reference job does. It generates the FLAC investigation files and runs
  `bootstrap --check` as `node`, which re-verifies the restored files against
  the pins and codec locks, so a wrong cache entry fails instead of being used.
  Caches are scoped to the branch, so reuse one probe branch to keep the cache.
- `probe` runs `node tools/linux/probe.mjs test --shard i/n` as `node`. Files are
  sharded round-robin, grouped by suite, and run with that suite's npm-script
  Vitest options. JSON reports are uploaded as `linux-probe-shard-<i>`.
- `corpora` runs `generate-corpora.mjs` as `node` and uploads
  `compat/behavior-specs/**/linux-x64/**` as `linux-x64-corpora`.

`workflow_dispatch` works only once the file is on the default branch.

## Local container loop: `tools/linux/container-run.mjs`

For fast iteration on macOS, Docker Desktop runs the pinned image under Rosetta
(`--platform linux/amd64`). Its results are drafts. CPUID reports VirtualApple,
which can change FFmpeg's runtime dispatch and V8 code generation, so only
GitHub's runs count as Linux evidence.

```sh
npm run reference:build:linux                 # once: .build/linux-x64/reference (5e43da9a…)
npm run linux:test -- tests/unit/reference-identity.test.ts tests/integration/node-permissions.test.ts
npm run linux:test -- --label my-check tests/differential/adelay.test.ts
npm run linux:corpora -- --draft --only node-permissions
node tools/linux/container-run.mjs exec -- node -e "console.log(process.arch)"
```

- The container runs as `--user 1000:1000 --network none` with a tmpfs `/tmp`.
  Docker Desktop bind mounts do not enforce POSIX permissions or errno like
  ext4, so permission tests must use `/tmp`, which `os.tmpdir()` gives.
- The checkout is mounted read-only at `/workspace`. A writable scratch
  `.build` comes from `.build/linux-green/container/build`.
- `.build/linux-x64/reference` is mounted read-only at `/workspace/.build/reference`,
  after it has been verified to be the linux-x64 pin. Pass `--reference <dir>` to
  use another copy.
- `openh264.wasm` and `edge-flac.wasm` are verified against their locks and
  copied into the scratch `.build`.
- A Linux `node_modules` lives in `.build/linux-green/container/node_modules`.
  It is installed by a networked `npm ci` and reinstalled when
  `package-lock.json` changes.
- In a git worktree, the git common directory and the realpath of a symlinked
  `upstream/ffmpeg` are mounted read-only at the same absolute paths. Git's
  `safe.directory` is set through the environment.
- Each run first generates the Linux FLAC investigation files into the scratch
  `.build` with the bootstrap.
- Reports go to `.build/linux-green/<label>/` (default `linux-test`), with
  `container-run.json` recording the image, reference and Wasm hashes. Drafts go
  to `.build/linux-green/drafts/`.

## Isolated Linux reference build

Run `npm run reference:build:linux` with Docker available. The command uses the
`linux/amd64` image digest recorded in `compat/reference-container.lock.json` and
the existing source-integrity checked `reference:build` command. It uses the same
upstream commit and configure flags as a local build. An ARM host requires Docker
to support x86_64 emulation.

Every GitHub Actions job uses the same image digest directly as its job
container. Node/npm and the compiler come from that container. Updating the lock
requires updating the workflows' container images and the linux-x64 pin in
`compat/reference-pins.json` as well; `tests/unit/reference-identity.test.ts`
checks that they agree.

The repository is mounted read-only, and network access is disabled during the
build. Docker may download the pinned image before starting the container.
Artifacts and compiler/platform metadata go to `.build/linux-x64/reference/`;
the host's `.build/reference/` is preserved. After a successful target check,
`.build/linux-x64/container-run.json` records the container digest and artifact
hashes. The command removes the previous successful run record before starting;
a failed build does not leave a successful run record for the new attempt.

This command builds an additional oracle. It does not run differential tests,
replace the current capability manifest, or certify Linux conformance. Existing
tests use `.build/reference/`. Default inverse-pixel comparisons choose explicit
portable arithmetic from the validated oracle build metadata: macOS arm64 uses
AArch64 arithmetic and the fixed Linux x86_64 build uses its MMXEXT profile.
Unknown reference targets and x86 external-assembly configurations are rejected;
the native default CPU options are unchanged. Historical instability records
identify their original macOS binary separately from the current oracle. This
test configuration does not change the public API's initial default profile.

The image digest pins the container filesystem; reproducible binary identity has
not been verified with independent clean builds. Build metadata therefore retains
`reproducibleToolchainPinned: false` rather than inferring reproducibility from a
successful build.

After building, run `npm run reference:probe:linux` for an inverse-pixel diagnostic.
It compares 560 format/geometry combinations against both the native default and
explicit `-cpuflags 0` output, recording matches for the portable AArch64, x86_64 and scalar
implementations. The report at `.build/linux-x64/inverse-probe/report.json` includes
all case hashes, reference metadata and the portable source bundle hash. AArch64
guard rejections are retained as observations. Completion of this diagnostic is
not a conformance gate: inspect the match counts and individual cases.
The old diagnostic report is removed before each attempt. Fourteen even-height
NV12/NV21 to RGB24 cases repeat the native default eight times and retain every output hash;
this measures observed variation without claiming that eight identical outputs
prove determinism.

### First measured inverse-pixel results

On 2026-11-20 the pinned container completed the Linux x86_64 reference build with
Debian GCC 12.2.0. Its ffmpeg SHA-256 is
`5e43da9ad1ee070f7e27c171b2ed2a311100f3d484d86f97f182e46d8ba68c91`.
The [recorded fixtures](../../compat/behavior-specs/inverse-linux-x64.json) retain
140 native default/scalar case hashes, input generation rules, compiler and build
configuration, and the container digest.

All 140 explicit `-cpuflags 0` outputs matched the portable scalar implementation.
The native default matched it in 116 cases and differed in 24. The four repeated
aligned NV12/NV21 cases produced one hash each across eight executions; this does
not prove general determinism. The existing AArch64 model matched only 56 of the
140 default outputs and explicitly rejected 28 geometries.

The build has `HAVE_X86ASM=0` but `HAVE_MMXEXT_INLINE=1`. In separate diagnostic
controls, disabling only MMXEXT removed all 24 observed differences. The pinned
source's x86 swscale initializer selects inline MMXEXT packed-output functions.
This identifies arithmetic and dispatch paths that need their own strict default
comparisons; scalar controls are not substituted for native default results.
This evidence is scoped to these formats, geometries, payloads and emulated CPU.

The subsequent x86_64 profile implements these packed-output paths in portable
TypeScript. A fresh expanded run passed all 560 native-default and 560 explicit
scalar comparisons over sixteen geometries. Fourteen even-height semiplanar
RGB24 cases had no observed variation across eight default repetitions each.
The [expanded fixtures](../../compat/behavior-specs/inverse-linux-x64-expanded.json)
and unit, launcher and workerd tests retain these scoped contracts. Multi-frame,
time/framecrc differential coverage and full Linux reference CI remain incomplete.

### Multi-frame and framecrc diagnostic

`npm run reference:probe:linux-time` prepares and executes 4,480 comparisons: five
source formats, seven RGB destinations, sixteen geometries, two arithmetic
profiles, full versus output-time-clipped selection, and raw versus framecrc.
Each input contains two deterministic frames. Portable execution uses eleven-byte
physical reads. The native default uses unchanged CPU options; the independent
scalar condition uses `-cpuflags 0`.

For staged execution, use `-- --prepare-only`, then `-- --run-prepared`.
`-- --check-prepared` verifies the prepared cases without native execution.
`-- --finalize-prepared` validates and summarizes already captured native results
without running the oracle again. Preparation replaces the working evidence, so
do not prepare concurrently with an existing run. The working directory is
`.build/linux-x64/inverse-time-probe/`; archive it before beginning a new run when
the previous evidence must be retained.

The command checks all 4,480 distinct case IDs and exact reference arguments,
input generation/hashes, portable payload hashes, source bundle identity, native
program identity and the reference binary hash. Missing/changed data fails the
command. A complete comparison with mismatches writes a failed summary and exits
nonzero. Reports retain preparation time and payload/result hashes. This is a
diagnostic command, separate from full reference CI and runtime performance
certification.

The first completed time/framecrc experiment passed all 4,480 comparisons and
retained a stable reference binary. The full working evidence was archived at
`.build/evidence/linux-inverse-time-2026-11-20T05-15-34-084Z/` with source and
artifact hashes. [Locked output hashes](../../compat/behavior-specs/inverse-linux-time.json)
now drive `tests/integration/pixel-linux-time.test.ts` without requiring Docker
on every regression run. This covers two frames at 25 fps, full selection versus
output `-ss 0.02 -t 0.05`, both output formats and both arithmetic conditions.
Other seek/deadline combinations, rates, payloads and full Linux CI remain
unverified. The original preparation did not snapshot the whole repository;
the recorded portable bundle identity and every input/output payload were
validated when finalizing the experiment.
