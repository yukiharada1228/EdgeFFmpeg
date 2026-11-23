#!/usr/bin/env bash
set -euo pipefail
source_dir="$1"
emsdk_dir="$2"
tool_dir="$3"
output_dir="$4"
edge_ffmpeg_cache_dir="${5-}"
set +u
source "$emsdk_dir/emsdk_env.sh" > /dev/null 2>&1
set -u
if [[ -n "$edge_ffmpeg_cache_dir" ]]; then
  export EM_CACHE="$edge_ffmpeg_cache_dir"
fi
[[ "$(emcc --version)" == *'7.0.0'* ]]
emcc --version > "$output_dir/compiler.txt"
# The verified build uses a blank VERSION_NUMBER. Do not derive it from a
# surrounding repository when rebuilding a source-only distribution.
printf '#ifndef VERSION_GEN_H\n#define VERSION_GEN_H\n\n#define VERSION_NUMBER ""\n\n#endif // VERSION_GEN_H\n' > "$source_dir/codec/common/inc/version_gen.h"
make -B -o generate-version -C "$source_dir" -j1 libopenh264.a OS=gnu ARCH=wasm32 USE_ASM=No USE_STACK_PROTECTOR=No CC=emcc CXX=em++ AR=emar
em++ "$tool_dir/wrapper.cpp" "$source_dir/libopenh264.a" -I "$source_dir/codec/api/wels" -I "$source_dir/codec/common/inc" -I "$source_dir/codec/decoder/core/inc" -I "$source_dir/codec/decoder/plus/inc" -O3 -sSTANDALONE_WASM=1 -sIMPORTED_MEMORY=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 -sSTACK_SIZE=1048576 -sABORTING_MALLOC=0 -sERROR_ON_UNDEFINED_SYMBOLS=1 -sEXPORTED_FUNCTIONS='["_edge_abi_version","_edge_create","_edge_decode_order","_edge_destroy","_edge_decode","_edge_info","_edge_forbidden_thread_calls","_malloc","_free"]' -Wl,--no-entry -Wl,--export-memory -Wl,-Map,"$output_dir/link.map" -o "$output_dir/openh264.wasm"
