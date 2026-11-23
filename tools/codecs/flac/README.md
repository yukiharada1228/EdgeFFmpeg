# Pinned libFLAC decoder build

Offline prerequisites: Python 3, Bash, Node (development inspection only), CMake,
and an installed emsdk 7.0.0 checkout at commit
`708dcbcc9ee23bc7d2dad44fc90db377e38b771c` with its populated compiler cache.
No downloads or installation are performed. Supply all paths explicitly:

```sh
python3 tools/codecs/flac/build.py \
  --source /local/flac-1.5.0 \
  --archive /local/flac-1.5.0.tar.xz \
  --emsdk /local/emsdk \
  --out .build/codecs/flac-rebuild-unique
```

The output must not exist. Every official archive member and the complete local
source file set are verified before compiling; symlinks and hardlinks are checked
and unsafe paths rejected. The archive hash and upstream release commit are in
`inputs.json`; the release commit is attribution, not a claim that an extracted
tarball is a Git checkout. Build, copied compiler cache, link map, compiler version,
source verification, inspection and metadata remain inside the new output.
Compilation uses `--parallel 1`. Only the static FLAC target and original
`wrapper.c` are linked, with programs, tests, examples, C++, Ogg and threads off.

`inputs.json` pins wrapper, recipe, verifier, ABI and license hashes. The expected
reactor is 69,607 bytes, SHA256
`d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f`.
A mismatch fails and retains metadata for investigation; do not silently repin.
`validate-wasm.mjs` checks the exact import/export inventory, fixed unshared
16 MiB memory and initialized ABI 1 / 29 info words. It does not certify decoding.
Use `node tools/codecs/flac/validate-wasm.mjs /path/edge-flac.wasm` independently.

The wrapper is ported unchanged from the proven development prototype. Its
terminal error policy and MD5 completion check remain intact; libFLAC CRC checks
are enabled. Clean finite PCM parity and known malformed-input policy differences
must be reported separately. This recipe makes no capability or full compatibility
claim. See package NOTICE-FLAC-DECODER and COPYING.BSD.libFLAC; the Emscripten
runtime notice is retained here. Release-wide licensing remains a separate audit.

Run the focused input and actual artifact checks after rebuilding:

```sh
FLAC_BUILD_ARTIFACT=.build/codecs/flac-rebuild-unique/edge-flac.wasm \
  node_modules/.bin/vitest run tests/unit/flac-build-inputs.test.ts --maxWorkers=1
```

Without that explicit artifact path, the positive artifact check requires
`.build/codecs/flac/edge-flac.wasm`. Build into that fresh output directory for
normal development tests. CI builds and shares the verified module before the
foundation and Workers checks; missing artifacts fail instead of skipping.
