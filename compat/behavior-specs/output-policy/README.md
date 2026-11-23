# Supported single-output overwrite policy

Regenerate with node tools/differential-runner/output-policy/generate.mjs.
13profiles cover WAVcopy/encode,AIFF,AU,rawPCM,audioframecrc,rawvideocopy,
videoframecrc,BMPcopy/encode/decode and H264rawvideo/framecrc. Five flag modes
(default EOF stdin,-n,-y,and both conflicting orders) with existing/absent
output yield130Native-only observations:52conflicts234,26refusals0,52copies0.
Owned inputs and the fixed H264 source are hash-bound. Independent cwd execution
reproduces inputs/results/provenance/manifest byte-for-byte.

Actual Node CLI and local workerd/R2 check statuses,canonical reason,output
preservation and no staging residue;refusal/conflict opens no output writer.
Positive cases verify output presence,not a new media-payload conformance claim.
Existing container/codec differential contracts continue to cover payloads.
Interactive input,full stderr,failed OS file effects and production Workers remain unverified. Multi-output
graphs have their own Native-only corpus and contracts. Custom VFS adapters must
provide outputExists for early refusal and retain atomic no-clobber commit.
