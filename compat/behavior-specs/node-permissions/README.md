# Owner-mode POSIX permissions

Run node tools/differential-runner/node-permissions/generate.mjs as an
unprivileged POSIX user.26owned profiles*4permission modes*5flags=520Native-only
observations. File/parent modes are set explicitly,all temporary modes restored
and all cases retained. Privileged execution fails rather than silently skipping.
The independent cwd regeneration reproduces all4JSON artifacts byte-for-byte.

Node compares every fresh/fixed Native status/reason and output effect.506status
matches include initial EACCES243 and overwrite conflict/refusal priority.14Native
in-place successes remain explicit Core runtime-blocked1cases:atomic replacement
requires parent write permission.12unresolved AAC mux-header failures retain234;
Native truncation differs from Edge old-output preservation. The test records
matched/known/unexpected counts separately and never claims full conformance.

Initial readable descriptors are opened/statted/closed without reading payload.
Later access revocation is an input-version change. Existing output refusal
precedes write access checks. With-y,target W_OK is checked before mux header
validation;atomic parent capability is checked when staging opens. Directory,
ACL,symlink,ownership,other errno/full log/descriptor/production semantics remain
outside this scoped fixture. R2 mount policy is not POSIX mode emulation.
