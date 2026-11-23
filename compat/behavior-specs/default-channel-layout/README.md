# Fixed reference default channel layouts

Regenerate with `node tools/differential-runner/default-channel-layout/generate.mjs`;an optional output directory supports independent repeats.

The host-only C oracle links the pinned Native libavutil and scans all channel counts1..65535. It records exactly13defined defaults,with mask integers stored as decimal strings. Native processing is never used by the runtime library.

The512CLI reference cases combine counts1..32,zero/four PCM16 frames,raw/WAV input,default/disabled guessing,and WAV/framecrc output. The differential test verifies complete bytes,statuses,diagnostics and fixture/source/reference-library hashes. The default-layout API uses immutable bigint masks;the selected Native WAV metadata profile accepts exact uint64 masks and applies normal-compliance serialization. Existing numeric low-level mask limits and the legacy WAV output profile remain bounded to32bits.

This scope does not certify arbitrary layouts,channel remixing,all sample formats or full FFmpeg compatibility. All512cases also have actual NodeCLI and workerd test contracts. The workerd matrix has passed with64byteIO bounds;the independent NodeCLI512matrix and broad regressions remain required before integration.
