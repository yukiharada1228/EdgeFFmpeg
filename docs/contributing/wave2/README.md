# Wave 2 cloud implementation

Wave 2 implements every capability that qualified in the readiness check (see
[`selection.json`](selection.json)): 67 work items covering 78 capability IDs, in four
launch batches. Each cloud agent starts from its batch's base branch, follows its own
specification in [`specs/`](specs/), and pushes a single-commit branch `wave2/<slug>`
with a report at `docs/contributing/wave2/<slug>.json`. Pushes to `wave2/**` run the CI
fast lane (typecheck, lint, boundaries and affected tests). Merged batches are checked
on real x86_64 through `linux-probe/wave2-batch-<n>` and finally by the full CI and the
macOS compatibility report. A branch is not compatibility evidence until that validation
passes. Deferred items and their reasons are listed in `selection.json`.
