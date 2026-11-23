# Intermediate path component is a file

Regenerate with node tools/differential-runner/node-path-type/generate.mjs.
26owned profiles*read/write*two component depths*five flag modes=520Native-only
observations:416ENOTDIR236/104output-conflict234. Input traversal failure precedes
overwrite conflict;output conflict precedes traversal. Native and actual Node
leave the blocker,output directory and staging unchanged. Independent cwd
reproduces all4JSON artifacts byte-for-byte;no cases are removed or relaxed.

Typed PathNotDirectoryError retains operation,virtual path,cause and236 for
initial open/probe/staging failures. A component replaced after accepting an
input handle is a version change/failure1. Adapter/group controls verify this
boundary and cleanup of earlier stages after a later invalid parent.
Directory-as-input/EISDIR,trailing slash,symlink/ACL/ownership/full OS/log races,
R2 prefix directory emulation and production remain outside this guarantee.
