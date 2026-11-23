# Isolated Linux reference build

Run `npm run reference:build:linux` with Docker available. The command uses the
`linux/amd64` image digest recorded in `compat/reference-container.lock.json` and
the existing source-integrity checked `reference:build` command. It uses the same
upstream commit and configure flags as a local build. An ARM host requires Docker
to support x86_64 emulation.

The GitHub Actions reference job uses the same image digest directly as its job
container. Node/npm and the compiler come from that container. Updating the lock
requires updating the workflow's container image as well. Remote CI execution is
still unverified.

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

## First measured inverse-pixel results

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

## Multi-frame and framecrc diagnostic

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
