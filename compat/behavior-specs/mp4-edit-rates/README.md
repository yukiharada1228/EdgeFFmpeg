# Default MOV edit rate field handling

Regenerate with `node tools/differential-runner/mp4-edit-rates/generate.mjs`.
The Native-only generator verifies binary and source manifests, changes the
rate words of12 owned v0/v1 multiple-edit inputs to8 values, and probes96 fresh
Native streamcopy outputs. Each output also equals the corresponding unit-rate
control. Frozen outputs include IDs/dispositions and packet clocks/flags/payload
hashes; the helper verifies all generator/source/input/result hashes.

Pinned mov_read_elst reads the field as unsigned16.16; default mov_fix_index does
not use the stored rate. Zero, small fractions,1/2,3/2,2 and high-bit-set words
therefore preserve the reference's existing timeline. This reproduces default
advanced MOV behavior; it does not apply a mathematical playback-rate transform.
Node and local workerd/R2 exercise actual CLI copies plus transactional failures.
Container byte identity, general strict options and other edit semantics remain
outside these contracts.
