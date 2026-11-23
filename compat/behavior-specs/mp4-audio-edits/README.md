# AAC-LC MP4 edit and copy timing

Regenerate with `node tools/differential-runner/mp4-audio-edits/generate.mjs`.
The generator verifies pinned Native binaries and owned source manifests before
and after execution.69 inputs comprise60 mono/stereo,primed/unprimed AAC inputs
at8k/44.1k/48k with five delays and9 two-audio mixed-clock inputs.54 jobs cover
auto/first/later/both/reverse/duplicate maps.36 single inputs use ELSTv0 and24
use ELSTv1. All expected values come from Native; candidate outputs are unused.

Source probes retain stream/global start,packet clocks/positions/flags and
skip-sample side data.114 copies compare fields,side data and payload hashes
on Node and local workerd/R2. Container bytes are not compared. Helpers validate
unique IDs and generator/source/artifact/input hashes. A second full execution
in an independent directory reproduced all five JSON artifacts byte-for-byte.

AAC nominal sample rate/frame length comes from ASC. Mux presentation/end-edit
uses max(nominal frame duration,packet duration)-discard padding; STTS retains
packet durations. Skip-sample plan stamps are deep-copied and validated against
payload iteration. A changed stamp aborts staging and preserves prior output.

General multiple-media AAC edits,long-range unaligned trimming,strict/probing/
metadata/error semantics and measured production resources remain unfinished.
This continuation stays isolated from Root's running v29 report.
