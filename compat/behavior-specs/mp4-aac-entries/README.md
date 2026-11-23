# AAC-LC AudioSpecificConfig precedence and copy headers

Regenerate with `node tools/differential-runner/mp4-aac-entries/generate.mjs`.
The Native-only generator checks pinned binaries and owned source manifests
before/after generation.108 inputs cover12 mono/stereo,primed/unprimed AAC-LC
sources at8k/44.1k/48k and nine single-field sample-entry mutations:rate0,8000,
44100,48000,65535 or channel count0,1,2,7. Controls with matching values remain
in the corpus. Original AudioSpecificConfig bytes are unchanged.

Native ASC parameters take precedence over sample-entry rate/channel words.
The demux API exposes the effective codec sample rate and codec channels while
preserving source sample-entry bytes and raw container channel count. A zero
rate/channel word is accepted when valid supported ASC supplies the parameter.
Copy output regenerates the audio rate/channel words from ASC parameters as in
pinned mov_write_audio_tag. Tests compare actual sample-entry tag/version/rate/
channel fields as well as stream/packet metadata and encoded payload hashes.
Container byte identity is not claimed.

Source probes retain original entry-header words,stream/global start,timebase,
duration/count/effective rate/channels,packet clocks/positions/flags and skip
samples. Node and local workerd/R2 compare fresh Native output with frozen
expected values; rollback controls remain required. Helpers bind unique IDs,
source/generator/artifact hashes and individual input bytes. This does not
certify unsupported ASC object types,compressed AAC decoding,general probing/
error semantics or measured production resource conformance.
