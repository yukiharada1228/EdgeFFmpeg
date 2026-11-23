# Pinned OpenH264 Wasm build

This tool builds the independent codec module consumed by the public avcodec
H264 API. It does not deploy, publish, download SDKs, or modify the supplied
source checkout. Supply a clean checkout of the exact OpenH264 commit and the
pinned local emsdk checkout named in `build.lock.json`.

```sh
node tools/codecs/openh264/build.mjs \
  --source /path/to/clean/openh264 \
  --emsdk /path/to/emsdk \
  --out .build/codecs/openh264
```

The output directory must not exist. A separate shallow local checkout is
created there, the exact managed patch is applied, and every C/C++ object is
rebuilt with Emscripten7.0.0. Assembly, OS threads and native fallback are not
used by the decoder adapter. The resulting module has imported memory with
16MiB initial/64MiB maximum size. `build-metadata.json` records compiler,
source/input hashes and the actual linked archive hashes. The build fails if
the output differs from the pinned, independently verified Wasm artifact.

The module exports `edge_abi_version()` returning2. Its18word frame record
includes the MMCO5 reset boundary separately from the key-picture flag.
The managed patch computes progressive POC types1/2 with bounded integer
intermediates. Public adapters reject incompatible ABI versions explicitly.

`source.patch` retains original BSD notices. `LICENSE.OpenH264` accompanies
the SDK modifications; `wrapper.cpp` is the independent API adapter. Runtime
library source-specific notices and release source packaging still need the
redistribution inventory described in docs/codecs/h264.md. The build checkout
contains upstream sample media; this tool does not grant redistribution rights
to them. Do not distribute the entire build directory as a codec package.

CLI/MP4 decode integration is connected. Scoped progressive decoder contracts
are in `compat/behavior-specs/h264`; broader CLI fixture promotion remains
separate work. Building this module does not declare general H264 compatibility.

## Corresponding source staging

After a verified build, create a fresh source-only staging directory:

```sh
node tools/codecs/openh264/stage-source.mjs \
  --build .build/codecs/openh264 \
  --out .build/codecs/openh264-sources
node .build/codecs/openh264-sources/build/rebuild-source.mjs \
  --emsdk /path/to/emsdk \
  --out .build/codecs/openh264-source-rebuild
```

The staging contains372pinned patched SDK source/build files, the managed
patch/wrapper/recipe, and TypeScript adapter sources with retained notices.
SDK sample media, platform demo images, test binaries and Git metadata are
excluded. A fixed source-file manifest is checked before compiling into a
separate output tree. The blank version header is explicit, so surrounding
Git repositories do not affect the codec version string or artifact.

This is corresponding-source staging, not a finished binary release package.
Compiler-runtime notices and final redistribution assembly remain pending.


For an isolated runtime-library rebuild, pass `--cache /absolute/new-cache`
to either `build.mjs` or the staged `build/rebuild-source.mjs`. Choose a fresh
cache directory to rebuild Emscripten system libraries; an existing directory
reuses its cached libraries. The explicit path is restored after sourcing
`emsdk_env.sh`, which otherwise clears inherited `EM_CACHE`. Omitting `--cache`
keeps the SDK default. Compiler and linker flags are unchanged. A fresh cache
rebuilds runtime libraries and headers; the LLVM/Clang/Binaryen tool binaries
are still the pinned prebuilt toolchain, not rebuilt from source.
