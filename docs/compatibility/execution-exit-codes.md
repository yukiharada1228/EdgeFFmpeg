# Execution exit statuses

ExecResult.exitCode is a number:0 denotes success,generic failures remain1,
and an ExecutionError may explicitly supply a process-style failure status
from1through255 via its optional third constructor argument `{exitCode}`.
Invalid/success/fractional values are rejected. Ordinary errors carrying a
similarly named property are not trusted. Cancellation continues to return1
with the cancelled diagnostic even if the backend reports another status.
The Node CLI forwards the result status;Workers return the same status in the
API result. This widens the previous TypeScript0|1 result type.

The first scoped Native mapping is an unset selected MP4 audio sample rate.
Pinned mux.c returns AVERROR(EINVAL),and ffmpeg.c returns that signed value;
the observed process status is234. MP4 copy checks selected streams after codec
resolution and reports invalid-arguments / sample rate not set with status234
before creating output. An unselected bad-rate stream does not force failure.

Native-only fixtures cover12original unresolved cases plus54mapping jobs from
9two-audio inputs:27successes and27status234failures. Fresh/frozen Native output
fields/payload hashes and the canonical reason are tested on Node/workerd-R2.
Full Native log formatting,all other failure mappings,cancellation process
semantics and Native OS output side effects remain outside this guarantee.

The scoped MP4 -y/-n conflict now returns234 and the canonical conflict reason,
for either flag order,after source/selected-codec validation and before the
selected-audio sample-rate check. Existing/absent output is preserved.
Historically Native overwrite refusal returned0 via AVERROR_EXIT while Edge
returned1 or234. The graceful ExecutionExit continuation below resolves the
named MP4 Node/R2 scope;generic error protocol remains uncertified.

ExecutionExit is a separate graceful-termination signal,not an ExecutionError.
FFmpeg.exec returns0,empty outputs and its code/message diagnostic without an
error field;aborted requests still return1/cancelled. Backends must only use it
before publication. Foreign errors with exitCode0 are not trusted.

VirtualFileSystem.outputExists(path,signal) is an optional non-mutating writable
path check. Built-in Node and R2 adapters implement it with path/mount policy
validation and cancellation checks. Existing adapters remain source-compatible;
custom adapters must expose this method for early overwrite refusal semantics.
The atomic no-clobber commit remains mandatory even after a negative preflight.

MP4 copy now checks conflicts,then existing-output refusal,then selected-audio
sample rate. Without-y,an existing output yields ExecutionExit/output-exists/0,
matching fixedNative AVERROR_EXIT with EOF stdin or-n. No writer is opened.
This resolves54named Native0/Core1-or234 differences. General formats and full
interactive/log/OS protocol remain incomplete;failed muxes may leave empty OS
files in Native whereas Edge retains atomic publication/abort behavior.

The same output-policy helper now covers the finite PCM backend (WAV,AIFF,AU,
rawPCM and framecrc),rawvideo,BMP image2pipe and configured MP4 H264 decoding,
as well as MP4copy. A separate130case Native-only corpus tests13named valid
single-output profiles for both flag orders/default EOF/-n/-y and output
existence. Source/selected-codec validation precedes this policy;media processing
and output writer creation follow it. Resource/unsupported-filter validation
may still happen earlier in individual planners,and general error precedence
is not certified. Complex/multi-output graph paths have separate contracts below.

Default complex/replay multi-output rawvideo commands and the six explicit
timed schedulers now validate overwrite policy for every output after opening
input metadata and before writer/spool allocation. Graceful refusal retains0
rather than being wrapped as an execution failure. ComplexVideoFailure preserves
an explicit ExecutionError status when cleanup succeeds;cleanup failure remains1.
Known Native side effects differ:opening an earlier OS output can leave it
empty when a later output refuses overwrite. Edge preflights all outputs and
publishes none,as required by the atomic VFS design. This difference is recorded
in multi-output-overwrite-side-effects.json and excludes full protocol conformance.

OutputGroup performs a final all-destination existence check before the first
no-clobber commit. Observed races abort every stage with failure1;they are not
a graceful initial refusal after processing has already started. Conditional
commit still protects each destination. A later race or commit failure can
leave earlier outputs published;publishedOutputs/effects report that state.
Cross-object atomic publication is not claimed.

InputNotFoundError is a typed ExecutionError for initial VFS absence,with code
input-not-found,path/cause and status254 (fixed POSIX Native ENOENT=-2). Node
maps ENOENT while resolving/statting an initial input;R2 maps an initial null
head. Path/mount/security and other I/O errors keep their own failure behavior.
Source absence precedes overwrite conflict/refusal. Cancellation still wins1.
Once a version-bound Node handle has been accepted,disappearance on a later
range-open is NodeInputChangedError;R2 missing/changed generations likewise stay
InputChangedError,not initial absence254. Full Native log/OS descriptor behavior,
other errno mappings,custom adapters and production remain outside this scope.

OutputParentNotFoundError represents an initially missing writable parent on
Node,not a normally absent output file. It carries output-parent-not-found/path/
cause/status254. outputExists validates writable parent/path even when-y will
replace an existing output. Conflicting flags remain234 before parent checks;
parent errors precede selected AAC mux-rate errors. openWrite repeats parent
validation to cover deletion after preflight. OutputGroupError only propagates
a typed status only if cleanup succeeded and every opened stage is confirmed
aborted (or none was opened);otherwise failure1 and explicit effects remain.
R2 key prefixes are not local filesystem directories;this directory-specific
scope does not claim their emulation. Other open errors and full protocol remain
unverified. outputExists implementers must support non-mutating validation even
when overwrite is enabled;atomic publication protections remain unchanged.

PermissionDeniedError carries operation(read/write),virtual path,cause and
initial EACCES status243. Node initial openRead now verifies a readable descriptor,
stats and closes it without reading payload. Revocation after acceptance remains
NodeInputChangedError/failure1. Arbitrary error properties are not trusted.

VirtualFileSystem.outputExists may receive optional WriteOptions as its third
argument. Wrappers must forward it;implementations snapshot accepted overwrite
policy before I/O. Existing-output refusal0 happens before access checks. With-y,
existing target write access is checked before mux-header validation. Atomic
staging capability is checked when a writer opens. A writable existing file in
a non-writable parent can succeed in Native in-place writing,but Node atomic
replacement returns NodeAtomicOutputUnavailableError/runtime-blocked1.14named
status differences and12same-status/OS-effect differences remain explicit.
Caller permissions are not changed to force publication. Successful cleanup
allows runtime-blocked reasons through OutputGroup;cleanup failures retain
publication effects/error instead. R2 mount policy,other errno/full logs/ACL/
symlink/descriptor/production behavior are not certified by this mapping.

PathNotDirectoryError carries read/write operation,virtual path,cause and initial
ENOTDIR status236. Node maps initial realpath/probe errors and initial staging
open errors;input traversal fails before overwrite conflict,while output
conflict is checked before output traversal. A component replaced after an input
handle is accepted remains NodeInputChangedError/failure1. Initial staging-open
ENOENT/EACCES are also mapped to their typed254/243failures;group cleanup and
publication uncertainty still take precedence over a clean typed status.
This only covers an intermediate regular-file component. EISDIR,input itself a
directory,trailing slash,other OS/log/descriptor/custom-adapter/R2prefix and
production behavior are not certified.

OutputIsDirectoryError retains path/cause and output EISDIR235. Existing output
directory refusal still returns0 without-y;with-y,it fails235 before mux header
validation. Node preserves a trailing directory separator through path resolution:
a regular input/output file with slash returns236,and an absent trailing-slash
output directory returns254. Canonical root containment precedes metadata checks
through trailing-slash aliases. openWrite repeats type validation so a directory
created after preflight cannot be silently replaced. Directory/file children
remain unchanged and group cleanup is still explicit. Input itself a directory,
full symlink/ACL/ownership/descriptor/OS-race/R2prefix/production behavior remain
unverified;the prior atomic-permission capability differences are unchanged.


### Initial directory reads and diagnostics with outputs

`InputReadError` represents failure while reading an accepted input, with its path, trusted failure status and cause. A Node directory opens as a version-bound handle and reports EISDIR235 on a nonzero read; its stat size is never treated as readable media after the optional non-consuming probe fails. Bounds, cancellation, containment and generation checks remain active. Regular Node files have no eager payload probe.

The CLI meaning depends on discovery: declared raw PCM/video can retain known parameters and produce an empty output with a diagnostic and status0; `-xerror` makes that initial read failure fatal235, and the last `-xerror`/`-noxerror` wins. Initial BMP no-stream failure is234 and scoped MP4 discovery failure is183. Refusal/conflict checks precede the raw terminal read diagnostic. Zero frame/duration requests still retain it; unselected inputs do not.

`BackendContext.reportDiagnostic` is optional for direct callers and supplied by `FFmpeg.exec`. The frontend snapshots and freezes diagnostics, retains them with successful outputs or before a terminal diagnostic, bounds retained text/entry overhead, reports retention truncation, and ignores notifications after settlement. This accounting does not measure actual runtime heap use.

The unchanged1,932-case Native corpus records300 cases/354outputs with differences separately from matching statuses:264fatal-publication cases and36late refusals. The prior32default-encoder metadata caseIDs are retained as resolved with complete byte equality under the fixed serialization profile. General midstream failure, full logs and production/platform coverage remain incomplete. Valid headered BMP/MP4/H264 requests with xerror flags explicitly reject the unfinished midstream policy. See `compat/known-differences/node-input-directory.json`; this is not full conformance.
