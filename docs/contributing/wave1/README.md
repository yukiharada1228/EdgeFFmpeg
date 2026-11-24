# Wave 1 cloud implementation

Forty capabilities are implemented in parallel by cloud agents, one per
capability. Each agent starts from `prep/registries`, follows its own
specification in [`specs/`](specs/) and pushes a single-commit branch
`wave1/<slug>` with a machine-readable report at `docs/contributing/wave1/<slug>.json`.
[`selection.json`](selection.json) records why each capability was chosen,
its owned files, shared one-line registry edits, test strategy and
determinism notes.

Agents compare against a native FFmpeg 9.0.2 reference they build in the
sandbox, which is Linux x86_64. Branches are reviewed, merged and fully
validated afterwards; a branch is not evidence of compatibility until that
validation passes.
