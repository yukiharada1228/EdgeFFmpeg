# Staged Node launcher

`run.mjs` still validates each argv request,verifies an explicitly supplied H264
module,and constructs a fresh filesystem/backend/execution. It does not cache
media bytes,file handles,codec verification,outputs or execution results.

The optional trusted-workspace build cache lives under`.build/cli-launcher`.
Its key includes the entry,Node/platform/architecture,esbuild version and explicit
compiler override,workspace file paths and bytes,root package/lock/TypeScript
configuration,and CLI implementation. File identity encoding includes byte
lengths;workspace symlink targets are checked. New files invalidate the key,so a
new JavaScript file cannot silently shadow a previously resolved TypeScript file.

Artifacts are addressed by source key and output digest. A manifest is published
after its artifact using unique temporary files and rename. Cached bytes are
checked before import;missing/corrupt entries rebuild. Missing/externally
retargeted workspace links,directory symlinks and unavailable caches retain the
fresh build path. Source changes detected across a build fail explicitly.
Module evaluation errors propagate once rather than triggering a second import.

This is a disposable developer-workspace cache,not a security boundary against
host filesystem writers or a general atomic snapshot of source/toolchain edits.
Installed dependencies remain governed by the package lock/trusted toolchain.
It can be removed with other`.build`artifacts. Runtime packages contain no cache
logic and no Native FFmpeg dependency has been introduced.

The original256-case labelled Node integration test remains unchanged,including
its60,000ms timeout and Native byte comparisons. Scoped cached runs pass;an
alternating12-pair small-command measurement observed about97ms->67ms mean
process wall time under concurrent validation load. This is not media throughput
or proof that a future full-suite run will pass. Four independent-process cache
controls verify invalidation,corruption,fallback and single module evaluation.
