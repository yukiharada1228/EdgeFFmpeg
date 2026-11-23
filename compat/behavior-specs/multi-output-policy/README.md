# Two-output overwrite policy

Regenerate with node tools/differential-runner/multi-output-policy/generate.mjs.
7owned graph profiles cover single-input split raw/framecrc/mixed outputs,
forced-rate replay,two-input hstack and repeated physical input binding.
Five flag modes/default EOF and four output existence masks produce140Native
observations:56conflicts234,42refusals0,42successful copies0. Positive outputs
include fixed raw/framecrc SHA256. Native side effects are recorded,including
empty earlier files when a later output refuses overwrite.

Actual Node CLI/default workerd validate140cases each. Explicit timed backend
validates all140through6schedulers on Node and workerd (840each),including
positive payload hashes and owned spool disposal. Policy preflight occurs after
input metadata validation and before any writer/spool allocation. Existing
outputs remain unchanged and absent earlier outputs remain absent on refusal.
This atomic Edge rule differs from Native OS file effects;see the explicit
known-difference record. Full logs,interactive input,general error precedence,
custom VFS lacking outputExists and production Workers remain unverified.

63second-probe cancellation/failure/racing-object controls span default+6timed
schedulers and3representative graph paths. A final no-clobber recheck detects
objects created after initial preflight before any output commits. Conditional
commit remains required;later races can still yield ordered partial publication
and explicit effects. Cross-object atomic commit is not certified.
