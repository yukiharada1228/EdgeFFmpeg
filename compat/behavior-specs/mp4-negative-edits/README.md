# Negative MP4 video media times

Regenerate with `node tools/differential-runner/mp4-negative-edits/generate.mjs`.
The generator verifies Native binary/source hashes before and after execution.
Sixty-six cases mutate the first nonempty entry of owned contiguous/mixed-zero
lists on three sources. Versions0/1 cover-2,-3,-800,INT32_MIN;version1 also
covers-2^32,INT64_MIN+1 and INT64_MIN itself. Results freeze Native nofillin,
default packet probes and streamcopy fields/packet payload hashes. The helper
verifies generator/source/artifact/input hashes and complete unique case IDs.
A second execution in an independent directory reproduced every JSON artifact.

Default mov_read_elst accepts negative media times below-1; strict validation
is a separate Native option. get_edit_list_entry performs an unsigned overflow
check when media time and rescaled duration are added, sometimes yielding0.
INT64_MIN is an input search position and is not a missing output timestamp.
The reconstructed packet timestamps still retain their existing signed bounds.

Comparisons cover66 Node/R2 copies,792 Node and528 workerd/R2 H264
raw/framecrc outputs under default/scalar profiles and spatial conversion.
Three rollback controls retain prior R2 output. Container byte identity, general
strict/error/probing/metadata semantics and production resources remain open.
This continuation stays isolated from Root's running v29 report.
