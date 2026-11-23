#!/usr/bin/env bash
set -euo pipefail
source_dir="$1"
emsdk_dir="$2"
tool_dir="$3"
output_dir="$4"
set +u
source "$emsdk_dir/emsdk_env.sh" > /dev/null 2>&1
set -u
[[ "$(emcc --version)" == *'7.0.0'* ]]
emcc --version > "$output_dir/compiler.txt"
em++ "$tool_dir/fixture-encoder.cpp" "$source_dir/libopenh264.a" -I "$source_dir/codec/api/wels" -I "$source_dir/codec/common/inc" -O3 -sSTANDALONE_WASM=1 -sIMPORTED_MEMORY=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 -sSTACK_SIZE=1048576 -sABORTING_MALLOC=0 -sERROR_ON_UNDEFINED_SYMBOLS=1 -sEXPORTED_FUNCTIONS='["_edge_encode_owned","_edge_owned_data","_edge_owned_size","_edge_forbidden_thread_calls"]' -Wl,--no-entry -Wl,--export-memory -Wl,-Map,"$output_dir/link.map" -o "$output_dir/fixture-encoder.wasm"
