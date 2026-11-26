# Development compatibility report

After building the pinned native reference, run:

```sh
npm run reference:build
npm run compat:report
```

The command generates `compat/reports/current.md` and `current.json`, plus a fresh `.build/evidence/<run-id>/` directory. Reports/evidence are ignored by Git and uploaded as CI artifacts. CI's `report` job runs it as `compat:report -- --from-shards` (see [Sharded runs](#sharded-runs)) and uploads the `reference-evidence` artifact even when validation fails. Locally, `npm run validate:fast` produces the same report from parallel shards in 20 to 26 minutes on a 10-core Mac, against 70 to 81 minutes serially.

The runner validates reference source/lock/build commits, configure flags, tracked upstream modifications and both executable hashes before extracting capabilities. It refreshes explicit FATE inventory, executes the reviewed native/Edge FATE profiles with fresh provenance, and runs typecheck, portable declaration generation, lint, package boundaries, generated Worker type checks, dry-run bundling and all four test groups. With `--from-shards <dir>` it runs every one of these gates except the four test groups, which it takes from shard records. Each command has a log, exit status, duration and content hash. Vitest JSON is checked against the expected test files and actual assertion counts; unexpectedly skipped, missing, failed, malformed or unmatched evidence cannot pass validation. A skip is expected only under the platform policy below.

Source snapshots include tracked and untracked nonignored repository files, their hashes, revision and upstream state. Tests and tools are part of that snapshot. The runner compares snapshots before/after validation and also checks both native binaries and build metadata for changes. A changed snapshot fails development validation. This is local provenance evidence, not a signed build attestation or proof that unobserved external state remained fixed.

## Sharded runs

`npm run compat:report -- --from-shards <dir>` is the same report with the four test groups taken from shards that ran elsewhere: CI's shard jobs or `npm run validate:fast`. [CI and local validation](ci.md) describes the plan, the shard runner and the pipeline. The report applies these rules:

- It recomputes the shard plan from its own source snapshot, and the plan must place every test file the report expects in exactly one shard.
- Every planned shard must be present exactly once and must name that plan. It must have run exactly its planned files on the same Node, platform and arch.
- Its log and Vitest JSON must match the hashes recorded when it ran.
- Its JSON must report exactly its files with consistent counts.
- The merged results are summarized against the suite's full file list with the run's platform policy, exactly as a serial run's single JSON would be.

A missing, empty, partial, duplicated, unexpected or altered shard makes its suite `invalid-evidence`, so validation fails. No shard is ever skipped. `tests-<suite>` passes only when every shard exited 0. Source and reference stability also require each shard's before and after snapshots to equal the report's. Shard logs, records and JSON are copied into `.build/evidence/<run-id>/shards/`, and the merged JSON is written to `<suite>.json` as before. The report records `execution` (`serial`, or `shards` with the plan hash and counts) and each suite's `shards`.

## Platform-gated tests

Some native comparisons only hold on one platform's reference build. For example, the macOS arm64 reference contracts afade `ipar`'s `1 - (1 - gain) * (1 - gain)` into a fused multiply-add, which EdgeFFmpeg does not do. Such a test is skipped on other platforms. Its contract in `compat/test-contracts.json` declares the platforms where it must run:

```json
{
  "id": "filter.afade.ipar",
  "file": "tests/differential/afade.test.ts",
  "name": "matches native ipar fades on linux x64 for every spelling, source format, output and time selection",
  "modes": ["semantic", "bit-exact"],
  "platforms": ["linux-x64"],
  "scope": "..."
}
```

`platforms` is optional. If present, it is a non-empty list of distinct `<process.platform>-<process.arch>` identifiers, such as `linux-x64` or `darwin-arm64`. Any other value fails the report: an empty list, a duplicate, `linux-x86_64`, `linux/x64` or a capitalised name. A contract without `platforms` applies on every platform. The declaration lives only on the contract. A test without a contract cannot be platform-gated.

The run's platform is the host's `process.platform`-`process.arch`. It is used for gating only when the validated reference build's `build-metadata.json` names the same platform. Otherwise gating is disabled: every contract applies and every skip fails. The report records `platform.host`, `platform.reference`, `platform.policy` (null when gating is disabled) and the reason.

Each test result gets an `outcome`:

| Vitest status | Condition | Outcome |
|---|---|---|
| `passed` | | `passed` |
| `failed` | | `failed` |
| `skipped` | At least one contract names the test (exact file and full name). Every contract that names it declares `platforms`, and none of them lists the run's platform. | `not-applicable` |
| `skipped` | Anything else, including a skip on a listed platform | `unexpected-skip` |
| `pending`, `todo`, `disabled` | Always | `unexpected-skip` |

A file or suite fails on any failure or unexpected skip. A file or suite with no failure is `passed` if nothing was not applicable. It is `passed-with-not-applicable` if at least one test passed and some were not applicable, and `not-applicable` if no test passed. Validation accepts a suite that is `passed` or `passed-with-not-applicable`. It rejects a suite with no passed test.

A contract whose `platforms` lists the run's platform, or one without `platforms`, resolves as before. It passes when exactly one test with its file and name passed in a passing suite. It is `unverified` when no test matches, and `failed` otherwise. On a platform its `platforms` does not list, the contract is `not-applicable` when its test was skipped (`observed: "skipped"`) or is absent (`observed: "absent"`). If such a test runs there anyway, its result counts like any other. Every contract and suite result records the platform that produced it.

Not-applicable results are never evidence of passing. They do not count as passed tests, passing contracts or scoped bit-exact PCM cases. A file with a not-applicable test is not a passing referenced file for `withPassingReferencedFiles`. The Markdown report prints the platform in its validation line, its suite table and its contract table. It also lists every unexpected skip by file and name, and says on which platforms the not-applicable contracts still need a run. `schemaVersion` is 2.

The policy only sees Vitest statuses. A test that drops cases internally on some platforms, without skipping, still reports `passed`. `dcshift` and `aderivative` do this, and the report cannot detect it. A test whose title changes per platform is not named by its contract on the other platforms, so that skip is unexpected. `asoftclip`'s `type=alg` test used to be like this: on macOS its title carried the skip reason instead of `(linux/x64)`, so its skip failed the differential suite. Commit `9d0c088` made the title constant. Since then its macOS skip is not applicable, and the gate and the comparison are unchanged.

The 24 contracts for linux/x64-gated audio tests declare `"platforms": ["linux-x64"]`. They cover adynamicsmooth, aecho, afade, aintegral, asoftclip, compensationdelay, crystalizer, extrastereo, haas and stereowiden. Only `filter.afade.ipar` has a measured macOS difference. The pinned macOS arm64 reference (`1b86106f…ab92`) differs from the unfused formula in 78 of 302 `ipar` gains for `ns=301`. The other 23 gates are precautions from the wave specifications. Their scopes say that no macOS difference has been measured for them.

## Interpretation

- Development validation passes only when required gates, all suites, scoped comparison contracts and snapshot stability pass on the platform the report names. A contract that is not applicable on that platform is neither passed nor failed; validation still passes, and the report lists the platforms where those contracts must still run.
- Capability counts come from the reference manifest and are grouped by kind and declared implementation status. Codec families and separate encoder/decoder entries are not independent user-facing features.
- Passing referenced test files are navigation evidence. They do not automatically promote a capability or prove that every behavior in that feature was exercised.
- `compat/test-contracts.json` names exact differential test files/titles and human-reviewed scopes. Missing or renamed contracts remain unverified and fail the required development validation on every platform where they apply; on a platform their `platforms` does not list they are not applicable. Contract scope must be reviewed when test semantics change.
- Scoped bit-exact PCM counts refer to those payload fixtures. They are not WAV-file byte identity or a feature-wide compatibility percentage.
- Known differences, unverified conformance, native oracle platform/compiler/artifact hashes and FATE unported inventory remain explicit.

`compatibilityCertified` is always false in the current reporter. The local reference toolchain is not reproducibly pinned, macOS is not the canonical Linux target, workerd testing is not production Cloudflare testing, only four reviewed FATE profiles execute, and the implemented features remain partial. A green report is evidence of current development checks, not unconditional FFmpeg compatibility.

Failure reports also retain partial evidence. Every run uses a fresh directory, so old passing JSON cannot fill in missing results. If native reference validation fails, differential tests are recorded as not run; other suites can still provide debugging evidence.

Native differential tests run serially (in a sharded run, each differential shard is one serial Vitest process) with a 30-second default wall-clock test allowance because each comparison may launch many reference processes and await bounded filesystem operations. Explicit per-matrix timeouts still apply. These harness deadlines do not change numeric assertions, native options, I/O budgets or runtime CPU/resource limits, and are not performance-conformance evidence.
