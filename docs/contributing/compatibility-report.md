# Development compatibility report

After building the pinned native reference, run:

```sh
npm run reference:build
npm run compat:report
```

The command generates `compat/reports/current.md` and `current.json`, plus a fresh `.build/evidence/<run-id>/` directory. Reports/evidence are ignored by Git and uploaded as CI artifacts. The reference CI job runs the same command and attempts artifact upload even when validation fails.

The runner validates reference source/lock/build commits, configure flags, tracked upstream modifications and both executable hashes before extracting capabilities. It refreshes explicit FATE inventory, executes the reviewed native/Edge FATE profiles with fresh provenance, and runs typecheck, portable declaration generation, lint, package boundaries, generated Worker type checks, dry-run bundling and all four test groups. Each command has a log, exit status, duration and content hash. Vitest JSON is checked against the expected test files and actual assertion counts; skipped, missing, failed, malformed or unmatched evidence cannot pass validation.

Source snapshots include tracked and untracked nonignored repository files, their hashes, revision and upstream state. Tests and tools are part of that snapshot. The runner compares snapshots before/after validation and also checks both native binaries and build metadata for changes. A changed snapshot fails development validation. This is local provenance evidence, not a signed build attestation or proof that unobserved external state remained fixed.

## Interpretation

- Development validation passes only when required gates, all suites, scoped comparison contracts and snapshot stability pass.
- Capability counts come from the reference manifest and are grouped by kind and declared implementation status. Codec families and separate encoder/decoder entries are not independent user-facing features.
- Passing referenced test files are navigation evidence. They do not automatically promote a capability or prove that every behavior in that feature was exercised.
- `compat/test-contracts.json` names exact differential test files/titles and human-reviewed scopes. Missing or renamed contracts remain unverified and fail the required development validation. Contract scope must be reviewed when test semantics change.
- Scoped bit-exact PCM counts refer to those payload fixtures. They are not WAV-file byte identity or a feature-wide compatibility percentage.
- Known differences, unverified conformance, native oracle platform/compiler/artifact hashes and FATE unported inventory remain explicit.

`compatibilityCertified` is always false in the current reporter. The local reference toolchain is not reproducibly pinned, macOS is not the canonical Linux target, workerd testing is not production Cloudflare testing, only four reviewed FATE profiles execute, and the implemented features remain partial. A green report is evidence of current development checks, not unconditional FFmpeg compatibility.

Failure reports also retain partial evidence. Every run uses a fresh directory, so old passing JSON cannot fill in missing results. If native reference validation fails, differential tests are recorded as not run; other suites can still provide debugging evidence.

Native differential tests run serially with a 30-second default wall-clock test allowance because each comparison may launch many reference processes and await bounded filesystem operations. Explicit per-matrix timeouts still apply. These harness deadlines do not change numeric assertions, native options, I/O budgets or runtime CPU/resource limits, and are not performance-conformance evidence.
