// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavutil/sfc64.h, Copyright (c) 2024 Michael Niedermayer.
export interface Sfc64 {a:bigint;b:bigint;c:bigint;counter:bigint}
const wrap=(value:bigint)=>BigInt.asUintN(64,value);
export function nextSfc64(state:Sfc64):bigint{const result=wrap(state.a+state.b+state.counter);state.counter=wrap(state.counter+1n);state.a=state.b^(state.b>>11n);state.b=wrap(state.c+(state.c<<3n));state.c=wrap(wrap(state.c<<24n)|(state.c>>40n));state.c=wrap(state.c+result);return result;}
export function seedSfc64(state:Sfc64,seed:bigint):void{state.a=state.b=state.c=seed;state.counter=1n;for(let round=0;round<12;round++)nextSfc64(state);}
