# Fixed reference serialization metadata

Regenerate with `node tools/differential-runner/reference-metadata/generate.mjs`.
The336Native cases retain complete output bytes and hashes,reference binary
identities,and source hashes including the pinned libavformat version/mux/RIFF
files. Independent regeneration matched allthreeJSONfiles.

| Group | Cases | Scope |
| --- | ---: | --- |
| Audio |288|Eight integer/float/G711 formats;mono/stereo;0/3/16samples;WAV and framecrc;default/output-bitexact/output-fflags-bitexact|
| Raw video |24|gray/yuv420p;empty/nonempty;copy/encode;three metadata modes|
| Graph |21|Seven existing graphs;three metadata modes;also exercised through allsix timed schedulers|
| H264 |3|Owned MP4 fixture to framecrc;three output metadata modes|

The Node test compares462executions with every output byte,not only metadata
text. It validates reference/source/output hashes and owned-store disposal.
The old software-line substitution in the audio CLI differential was removed;
it now compares actual Native output text.

`metadataProfile:'ffmpeg-9.0.2'` selects the fixed serialization identity
`Lavf63.1.102` and scoped Native WAV RIFF fields. It identifies a compatibility
target,not an executing FFmpeg library. Low-level API defaults retain their
existing WAV/software identity. CLI mux paths select the profile explicitly;
output bitexact suppresses the encoder/software metadata. WAV reference fields
also cover canonical channel masks,float fmt form,and the empty non-PCM fact
sentinel. See `packages/containers/NOTICE-REFERENCE-METADATA` for provenance.

The unchanged1,932-case directory corpus now has1,632exact-output cases;its32
prior metadata-difference IDs remain recorded as resolved. The remaining300
cases/354outputs retain atomic error-publication and late-refusal differences.
This does not certify arbitrary metadata,all RIFF fields,large/RF64 output,
all channel layouts/rates,codecs,platforms or production Workers.
