# CI and local validation

Full validation runs the same checks as a serial `npm run compat:report`. The
test suites are split into shards that run in parallel, and one aggregate
report combines them. Every other gate runs once, in the aggregate.

Measured times (details under [Equivalence and timings](#equivalence-and-timings)):

- The full CI pipeline took 13 min 50 s with the reference from the cache, and
  20 min 28 s when it built the reference. Before, it took 3 h 9 min.
- The wave2 fast lane took 9 min 5 s.
- Locally, `npm run validate:fast` took 25 min 29 s on a 10-core, 16 GB Mac that
  other work was also loading. A serial `compat:report` takes 70 to 81 min.

## Which lane runs

`.github/workflows/ci.yml` picks the lane in its `plan` job
(`node tools/ci/plan.mjs auto`, function `laneFor`):

| Event | Lane |
|---|---|
| Push to `wave2/**`, unless a path segment starts with `integration` | fast lane |
| Push to any other branch: `feat/**`, `linux-green/**`, `ci-fast/**`, integration branches such as `wave2/integration` or `wave1/integration`, `develop` and the rest | full pipeline |
| Push of a tag, any pull request | full pipeline |
| Push to `linux-probe/**` | only `.github/workflows/linux-probe.yml` |

A newer push to a fast-lane branch cancels that branch's running fast lane. A
full-pipeline run is never cancelled by another push.

## Full pipeline

```
plan ──────────────┐
reference ─────────┴─> shard × 16 (unit 1, integration 3, differential 7, workers 5) ─> report
```

- **plan** computes the shard plan and the job matrix, and uploads the plan as
  `ci-plan`.
- **reference** provides `.build/reference`, both Wasm codecs and the three
  generated FLAC investigation inputs as the `worker-reference-and-codec`
  artifact. It restores them from the Actions cache when every pinned input is
  unchanged (see [Reference cache](#reference-cache)), and builds them otherwise.
  Either way it then generates the FLAC investigation inputs and runs
  `bootstrap --check` as `node`.
- **shard** (one job per plan entry) checks out the commit, downloads the
  artifact, runs `npm ci` and `bootstrap --check`, and then runs
  `node tools/ci/shard.mjs --suite <suite> --index <i> --out .build/shards --prepare`.
  It uploads `shard-<suite>-<i>`.
- **report** downloads the artifact and every shard, runs `bootstrap --check`
  and `npm run compat:report -- --from-shards .build/shards`, and uploads
  `reference-evidence` with the same paths as before. It runs whenever the run
  is not cancelled, so failing shards still produce a failure report.
  - The FATE gate runs `make` in `.build/reference`. An artifact does not keep
    the build tree's timestamps, and the fresh checkout's sources are newer than
    any restored object. Without a fix, `make` would rebuild FFmpeg: in run
    45687848828 it hit the FATE adapter's 120 s limit.
  - The job therefore first gives every file of the restored tree one timestamp,
    newer than the checkout. `make` then treats the tree as built, as it was in
    the job that built it. `bootstrap --check` still verifies the programs and
    libraries, and `referenceStable` fails the report if `make` relinks either
    program.

Where each check runs:

| Check | Before (run 45623569626) | Now |
|---|---|---|
| reference-extract, fate-inventory, fate-audio-audit, fate-execution | reference job | report job, once |
| typecheck, declarations, lint, boundaries | reference job and `foundation` (`npm run check`) | report job, once |
| worker-types, worker-bundle | reference job and `workers` | report job, once |
| unit | reference job and `foundation` | shard `unit-1` |
| integration | reference job | shards `integration-1` to `-3` |
| differential | reference job | shards `differential-1` to `-7` |
| workers | reference job and `workers` | shards `workers-1` to `-5` |

The `foundation` and `workers` jobs only repeated unit, workers and the
non-test gates, so they are removed. Each of those still runs exactly once, in a
job that `compat:report` reads.

Security and permissions are unchanged in kind:

- Every action is pinned by commit, with its release in a comment.
- The workflow has `contents: read`. Only the reference job adds
  `actions: read`, which lets a cache miss download another run's build (below).
- Every checkout sets `persist-credentials: false`.
- Every job runs in the pinned image and runs the tests, `bootstrap` and the
  CI tools as the unprivileged `node` user. Root runs only these steps:
  - `git` setup, `chmod`, `chown` and the report job's timestamp step;
  - in the reference job, `tools/ci/reference-cache.mjs`, which reads the
    checkout and the artifacts API;
  - the reference job's `npm ci` and build steps, as before.
- Matrix values reach shell steps through environment variables, never
  through interpolation, and `shard.mjs` validates them.

## Shard plan

`tools/ci/plan.mjs` assigns every test file of each suite to exactly one shard.

- `tools/ci/shards.json` sets the shards per suite: unit 1, integration 3,
  differential 7 and workers 5.
- `tools/ci/test-durations.json` holds the duration of every test file, from
  Vitest's `startTime` and `endTime`. The `linux-x64` profile comes from the
  `reference-evidence` artifact of run 45623569626, and it balances the shards.
  The `darwin-arm64` profile comes from the macOS report at `8f453a8`. It only
  orders the shards `validate:fast` starts on an Apple arm64 host. It never
  changes their files.
- Files are placed longest first. Each goes to the shard with the least time so
  far, and on a tie to the one with fewer files, so no shard is left empty. A
  file without a measurement, such as a new test, counts as its suite's mean.
  The planned shards take about 50 s (unit), 570 s (each integration shard),
  592 s (each differential shard) and 543 s (each workers shard) of measured
  test time.
- The plan is deterministic. Its `sha256` covers the mode and the file lists
  only. `validatePlan` rejects an empty shard, a file in two shards, a file
  outside its suite, unsorted lists and a hash that does not match the lists.
- Durations only balance the shards. They never select, skip or time out a test.
  To rebalance after the suites change, run
  `node tools/ci/durations.mjs --evidence <report dir> --profile linux-x64 --source "<run>"`
  on a passing `reference-evidence` artifact.

## Shard runner

`node tools/ci/shard.mjs --suite <suite> --index <i> --out <dir> [--plan <file>] [--prepare]`
runs one shard.

- The plan comes from `--plan`, from `EDGEFFMPEG_CI_PLAN` (the plan job's
  output) or, by default, from this checkout. A full plan supplied from outside
  must equal the one the checkout computes.
- The shard runs `npx vitest run <its files> <suite options> --reporter=default --reporter=json --outputFile=<suite>-<i>.json`.
  The suite options are parsed from the suite's npm script by `suiteOptions`
  in `tools/linux/probe.mjs`. They are none for unit, `--maxWorkers=1` for
  integration and workers, and `--maxWorkers=1 --testTimeout=30000` for
  differential. `vitest.config.mjs` (`maxWorkers: 1`) applies to all four, as
  before. Explicit file arguments replace only the suite directory.
- `--prepare` first runs `npm run reference:extract`. It rewrites the tracked
  `compat/capabilities.json`, whose Linux extraction differs from the committed
  macOS one, so the shard tests the same tree as a serial `compat:report` on that
  host. `validate:fast` runs it once before starting the shards instead.
- The shard records source and reference snapshots before and after the run.
  These are the same `snapshotSource` and `snapshotReference` that
  `compat:report` uses.
- It writes `<suite>-<i>.json` (Vitest JSON), `<suite>-<i>.log` and
  `<suite>-<i>.shard.json`. The record holds the files, the plan hash, the
  command, the exit code, the timings, the log and report hashes, the checkout
  root, the revision, both snapshots, the platform, Node, the preparation step
  and the CI run.

## Aggregate: `compat:report --from-shards <dir>`

The aggregate is `compat:report` with one change: it does not run the four test
commands. Every other gate runs as before, in the same order, so the gate list
is the same 14 names. For each suite it reads the shards
(`tools/compatibility-report/shards.mjs`):

- It recomputes the full plan from its own source snapshot. The plan must assign
  every test file the report expects to exactly one shard.
- Every planned shard must be present once, with no extra shard of the suite.
- Each shard record must name this plan (mode and hash), list exactly its
  planned files, and come from the same Node, `process.platform` and
  `process.arch`, and the same platform id.
- The log and the Vitest JSON must match their recorded hashes. They are copied
  into `.build/evidence/<run>/shards/`.
- Each shard's Vitest JSON must report exactly its files, with counts that agree
  (`summarizeSuite`). The merged results of all shards are then summarized
  against the suite's full file list, with the same platform policy as a serial
  run. They are written to `.build/evidence/<run>/<suite>.json`.
- `tests-<suite>` passes only when every planned shard exited 0. Its record
  lists every shard's command, exit code, duration, log and report.
- `sourceStable` and `referenceStable` also require every shard's before and
  after snapshots to equal the aggregate's.

| Shard problem | Result |
|---|---|
| Missing (no record), or an unexpected extra shard | suite `invalid-evidence`, validation fails |
| Empty: no file planned, or no test results | suite `invalid-evidence` |
| Partial: a planned file has no results, or counts disagree | suite `invalid-evidence` |
| A file in two shards, or a file outside the plan | suite `invalid-evidence` |
| A different plan, file list, Node or platform | suite `invalid-evidence` |
| Log or Vitest JSON altered after the run | suite `invalid-evidence` |
| No Vitest JSON (the process crashed) | suite `invalid-evidence` |
| A failed test or a non-zero exit | `tests-<suite>` and the suite fail, as in a serial run |
| A shard on another source snapshot or reference | `sourceStable` or `referenceStable` false, validation fails |

The report also gains `execution`: `{mode: "shards", directory, plan: {sha256, counts, files, estimatedSeconds, file}, records, sourceStable, referenceStable}`,
and `{mode: "serial"}` otherwise. Each suite gains `shards`. The Markdown report
names the shard plan. `tests/unit/ci-shards.test.js` covers the planner, the
lane rule, the selection and every rejection in the table above except the
platform check.

## Reference cache

`node tools/ci/reference-cache.mjs pins` gives the cache key and the build pins.

- The key is `reference-v1-linux-x64-<sha256>`. The hash covers `.gitmodules`,
  `compat/upstream.lock.json`, `compat/configure.flags`,
  `compat/reference-container.lock.json`, `compat/reference-pins.json`, the
  upstream gitlink, every tracked file under `tools/upstream-build`,
  `tools/codecs` and `tools/bootstrap`, and `reference-cache.mjs` itself. The
  OpenH264 commit, the emsdk commit and version, and the libFLAC archive SHA-256
  are in `tools/codecs`; the libFLAC URL and paths are in
  `tools/bootstrap/lock.json`.
- The build steps take these pins from the same step outputs. The workflow
  therefore no longer repeats them as literals, and the key covers exactly what
  the build uses. `KEY_VERSION` must be bumped when the build steps change.
- The step also fails when `EDGEFFMPEG_CONTAINER_IMAGE` is not the locked image.
- The cache holds `.build/reference` and the two `.wasm` files.
- Actions caches are visible only to their own branch and the default branch
  (`develop`, which does not run this workflow yet). On a miss, the reference
  job therefore looks for an unexpired `reference-build-<key>` artifact from
  another run of this repository, not a fork. The reference job uploads that
  artifact whenever it builds.
- Whatever the cache or the artifact restores is used only after
  `bootstrap --check` has matched `ffmpeg`, `ffprobe` and the six pinned
  libraries to the linux-x64 pin and both modules to their locks. A miss is
  saved only after that check. `reference-provenance` records which source was
  used: `cache`, `artifact of run <id>` or `built`.

## Fast lane

A push to a `wave2/**` feature branch runs:

- `plan`, which selects the affected tests;
- `reference`, as in the full pipeline;
- `checks`: typecheck, lint and boundaries;
- one shard job per planned shard of the affected tests;
- `fast`, which runs `node tools/ci/verify-fast.mjs`.

`verify-fast` applies the same per-shard and merged checks as the aggregate to
the selected files. It also requires the reference and checks jobs to have
passed. The fast lane gives feedback; it is not compatibility evidence. Only
a full-pipeline run produces the `reference-evidence` report, so an
integration branch must pass one before its work counts as validated.

`tools/ci/affected.mjs` selects a test file when one of the following holds:

- It changed.
- It is a registry test: its name contains `registry`. There are six today, the
  audio-filter, video-operator and container registry tests.
- It reaches a changed file through the dependency graph. The graph has the
  static imports from esbuild's metafile, JSON imports included. It also has
  repository paths written literally in a test or a module, such as a Workers
  fixture bundled at run time, a corpus file or directory, or a tool the test
  spawns.
  - The graph is not followed through the hubs in `fastLane.hubs`: package
    entry points (`packages/*/src/index.ts`) and registries
    (`packages/**/registry.ts`, `packages/**/registry-*.ts`). They re-export
    every capability, so nearly every test reaches every module through them.
    For example, `acopy.ts` is in 315 test bundles. A change to a hub is
    covered by the registry tests.

Every test file is selected when a changed file matches
`fastLane.allTestsWhenChanged`, when no branch point is found or when the graph
cannot be built. The patterns cover the npm and Vitest configuration,
TypeScript configuration, `wrangler.jsonc`, the submodule and every pin of the
reference, and the bootstrap, build, test, CI and report tools.

The changes are taken from the branch point: of the remote branches matching
`fastLane.bases` (`feat/**`, `develop`, `main`, `prep/**`, `*/integration*`,
`linux-green/**`, `ci-fast/**`), the one whose merge base with the head is the
fewest commits behind it. They also include uncommitted and untracked files when
the tool runs locally. Each suite gets
`ceil(estimated seconds / 360)` shards, at most its full-pipeline count.

Examples, against the current tree:

| Change | Selected test files |
|---|---|
| The `wave1/af-acopy` commit (filter, registry line, two tests, docs) | 8: both acopy tests and the six registry tests |
| `packages/avfilter/src/video-ops/formats.ts` | 35 (13 differential, 22 unit) |
| `packages/avformat/src/flac-wave-trim.ts` | 22 |
| `tests/helpers/reference-pixel-profile.ts` | 102 |
| `compat/behavior-specs/bmp/linux-x64/manifest.json` | 18 |
| `docs/contributing/wave1/vf-copy.json` | 6, the registry tests only |

Run `node tools/ci/affected.mjs` to see the local selection and why each test is
in it, or add `--changed <file> ...` to try a change set.

## Local: `npm run validate:fast`

`npm run validate:fast [-- --concurrency <n>] [--out <dir>]` does the following:

1. It runs `npm run reference:extract` once.
2. It runs every shard of the full plan, the same plan as CI, as separate
   `tools/ci/shard.mjs` processes. They start longest first, by this host's
   profile in `tools/ci/test-durations.json` when there is one, else by the CI
   estimates. Each is one Vitest process with its suite's options, so
   differential shards keep `--maxWorkers=1`.
3. It runs `npm run compat:report -- --from-shards <dir>`, and exits with its
   status.

- The default concurrency is `min(8, 60% of the logical CPUs, one shard per 2.5 GiB of memory)`.
  That is 6 on a 10-core, 16 GB Mac.
- Shards go to `.build/shards/<timestamp>/` unless `--out` is given. Each has a
  `<id>.runner.log` with its console output. `validate-fast.json` records the
  concurrency, every shard's start and duration, and the wall times.
- Do not edit the tree while it runs. A changed source snapshot fails
  validation, exactly as in a serial run.
- `upstream/ffmpeg` must be a real checkout. Git refuses to run `git status` in
  a worktree whose submodule path is a symbolic link, so a symlinked
  `upstream/ffmpeg` breaks the snapshot. Run
  `node tools/bootstrap/bootstrap.mjs --only submodule --ffmpeg-source <main checkout>/upstream/ffmpeg`
  to clone it locally in a few seconds.

To check a run against another report test by test, use
`node tools/ci/compare.mjs <baseline report.json> <candidate report.json> [--allow-added <test file> ...]`.
It compares developmentValidation, the platform, gates, stability, suite counts,
test files, every full test name with its status and outcome (as a multiset),
and every contract status.

## Equivalence and timings

Baseline: run 45623569626 on `40a90c7`, the last green run of the old
workflow, and the serial macOS `compat:report` at `8f453a8`. `8f453a8` differs
from `40a90c7` only in four time budgets, which rename no test.

### CI: run 45692212749 on `e78d1eb`

This run took the reference from the cache; its `ffmpeg` has the same SHA-256 as
run 45623569626's. `node tools/ci/compare.mjs` against run 45623569626 reports
`EQUIVALENT`. A separate check that reads only the raw Vitest JSON of the 16
shard artifacts, the aggregate's copies, the plan and Git agrees (see
[development status](development-status.md)):

- developmentValidation passed in both runs. Both ran on linux-x64, with a
  linux-x64 reference and Node v24.22.3, and both had a stable source and
  reference.
- Both have the same 14 gates, and all passed. FATE executed its 5 reviewed
  profiles.
- All 696 test files of run 45623569626 ran. Every full test name has the same
  Vitest status and outcome, and occurs as often:
  - unit: 2,933 passed and 11 not-applicable of 2,944;
  - integration: 2,081 of 2,081;
  - differential: 729 of 729;
  - workers: 277 of 277.
- All 1,155 contracts have the same status: 1,144 passed and 11 not
  applicable.
- The only addition is `tests/unit/ci-shards.test.js`: 6 tests, all passed.
  With them, unit has 2,939 passed and 11 not-applicable of 2,950 in 255 files.

Run 45687848828 on `a477f37`, the first push, built the reference. Its suites
matched run 45623569626 test by test as well. Its report failed only on
`fate-execution`, the `make` timestamp problem that `e78d1eb` fixes (see
[Full pipeline](#full-pipeline)).

### Local: `validate:fast` on `e78d1eb`

The run used an Apple M4 Mac mini (10 cores, 16 GB), Node v26.13.1 and
concurrency 6. `compare.mjs` against the macOS report at `8f453a8` reports
`EQUIVALENT`:

- developmentValidation passed on darwin-arm64, with a stable source and
  reference and the same 14 gates.
- unit: 2,933 passed and 11 not-applicable of 2,944, plus the 6 new tests.
- integration: 2,081 of 2,081.
- differential: 705 passed and 24 not-applicable of 729.
- workers: 277 of 277.
- Every test name and status is unchanged.
- contracts: 1,120 passed and 35 not applicable.

### Wall times

| Run | Wall time | Where the time went |
|---|---|---|
| 45623569626, old workflow | 3 h 9 min | The reference job took 2 h 34 min, 2 h 28 min of it in compat:report. |
| 45687848828, full, reference built | 20 min 28 s | Reference 5 min 32 s, longest shard 10 min 55 s, report 3 min 51 s (2 min of it the FATE timeout). |
| 45692212749, full, cached reference | 13 min 50 s | Plan 34 s and reference 1 min 1 s in parallel, longest shard 11 min 0 s, report 1 min 39 s. |
| 45692317726, fast lane on `wave2/ci-fast-probe` | 9 min 5 s | Reference 1 min 31 s from run 45687848828's artifact; checks 1 min 33 s; 35 test files (189 tests) in 2 shards, the longer 6 min 50 s. |
| Serial `compat:report`, macOS | 70 min at `8f453a8`, 81 min at `7c5e0e1` | |
| `validate:fast` on `a477f37`, concurrency 6 | 25 min 0 s | Failed once, on a native crash (open items). |
| `validate:fast` on `e78d1eb`, concurrency 6 | 25 min 29 s | Shards 1,500 s, report 29 s. |

The fast-lane probe pushed a comment-only change to
`packages/avfilter/src/video-ops/formats.ts` on top of `e78d1eb`. Its branch
point was `ci-fast/pipeline`. It selected 22 unit and 13 differential files and
passed. The branch is a probe only, not for merging.

In CI the shard time is the bottleneck. Each shard job spends 41 to 57 s on setup
before its tests start.
The longest test slices ran 9.1 min (workers), 9.8 min (integration) and
10.3 min (differential). The report needs about 1.5 min.

Locally the run is CPU-bound:

- At concurrency 6, every shard except unit ran 1.6 to 2.3 times slower than
  its files' serial macOS durations. Unit's 18 s of tests took 88 s, mostly
  start-up and transform.
- The shard durations add up to 8,312 s, which is 1,385 s per slot.
- Other processes used 2 to 4 cores during both runs: another project's Node
  processes and `mediaanalysisd`.
- About 20 minutes would need an otherwise idle machine; that was not measured.

## Open items

- **A native crash under parallel load.** In the first local run, the native
  reference crashed with SIGBUS on one case of
  `tests/differential/video-fillborders.test.ts`:
  `gbrp/20x10/fillborders=left=10:right=10:top=5:bottom=5:mode=reflect`.
  - The test expects native to fail with `Borders are bigger than input frame
    size.` Native died instead and printed nothing.
  - The macOS crash report shows `KERN_PROTECTION_FAILURE` 20 bytes before the
    start of a malloc region. That suggests an out-of-bounds read in native
    `fillborders`, which faults only when the buffer begins a VM region.
  - The file passed alone and in every other run, serial runs included. The test
    is unchanged.
  - Other heap-layout-dependent native reads may surface the same way.
- **Cache scope.** Actions caches are per branch plus the default branch.
  `develop` does not run this workflow, so a new branch's first run takes the
  build from another run's `reference-build-<key>` artifact, or builds it. That
  artifact keeps the repository's default retention.
- **Hubs in the fast lane.** A change that reaches a test only through a
  registry or a package entry point is not tested in the fast lane. Only the
  full pipeline on the integration branch tests it, so merge to integration
  before relying on it.
- **Pull requests.** A pull request from a `wave2/**` branch runs the full
  pipeline on top of the push's fast lane.
- **Job concurrency.** A full run has 19 jobs, 16 of them at once. GitHub's
  free plan runs 20 jobs at a time per account, so two concurrent full runs, or
  a full run and several fast lanes, queue.
- **Durations.** New test files count as their suite's mean until
  `tools/ci/test-durations.json` is regenerated. Rebalance when the suites grow
  substantially.
- **Worktrees.** The worktree setup that symlinks `upstream/ffmpeg` cannot run
  `compat:report` or `validate:fast`, because `git status` refuses a symlinked
  submodule path. Clone it with `bootstrap --only submodule --ffmpeg-source`
  (above).
- **Local target.** About 20 minutes locally was not reached on the shared
  machine (above).
