#!/usr/bin/env bash
# Original EdgeFFmpeg build recipe; libFLAC source is BSD-3-Clause.
set -euo pipefail
codec_source="$1"
codec_build="$2/build"
codec_out="$2"
codec_tools="$(cd "$(dirname "$0")" && pwd)"
export EM_CACHE="$codec_out/cache"
export EMCC_SKIP_SANITY_CHECK=1
set +u
source "$3/emsdk_env.sh" >/dev/null 2>&1
set -u
emcc --version > "$codec_out/compiler.txt"
emcmake cmake -S "$codec_source" -B "$codec_build" -DCMAKE_BUILD_TYPE=Release -DBUILD_CXXLIBS=OFF -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_DOCS=OFF -DBUILD_SHARED_LIBS=OFF -DWITH_OGG=OFF -DENABLE_MULTITHREADING=OFF '-DCMAKE_C_FLAGS=-O3 -ffunction-sections -fdata-sections'
cmake --build "$codec_build" --target FLAC --parallel 1
emcc "$codec_tools/wrapper.c" "$codec_build/src/libFLAC/libFLAC.a" -I "$codec_source/include" -DFLAC__NO_DLL -O3 -sSTANDALONE_WASM=1 -sASYNCIFY=1 '-sASYNCIFY_IMPORTS=["env.edge_host_read"]' -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 -sSTACK_SIZE=131072 -sMALLOC=emmalloc -sABORTING_MALLOC=0 -sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 '-sEXPORTED_FUNCTIONS=["_edge_flac_abi","_edge_flac_info_words","_edge_flac_async_data","_edge_flac_create","_edge_flac_info","_edge_flac_step","_edge_flac_destroy"]' --no-entry -Wl,--export-memory -Wl,-Map,"$codec_out/link.map" -o "$codec_out/edge-flac.wasm"
# Parsing imports,ABI and fixed memory limits must precede any decoder claim.
node "$codec_tools/validate-wasm.mjs" "$codec_out/edge-flac.wasm" > "$codec_out/module-inspection.log"
