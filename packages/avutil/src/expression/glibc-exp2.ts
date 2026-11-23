// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from glibc 2.36 e_exp2.c, non-FMA path.
// Copyright (C) 2018-2022 Free Software Foundation, Inc.
import {bits,fromBits,wrap64} from './glibc-bits.js';import {exp2Shift as SHIFT,exp2Poly as C,expTable as T} from './glibc-tables.js';
function special(tmp:number,sbits:bigint,ki:bigint):number{if((ki&0x80000000n)===0n){sbits=wrap64(sbits-(1n<<52n));const scale=fromBits(sbits);return 2*(scale+scale*tmp);}sbits=wrap64(sbits+(1022n<<52n));const scale=fromBits(sbits);let y=scale+scale*tmp;if(y<1){let lo=scale-y+scale*tmp;const hi=1+y;lo=1-hi+y+lo;y=(hi+lo)-1;if(y===0)y=0;}return 2**-1022*y;}
export function glibcExp2(x:number):number{if(Math.abs(x)<2**-54)return 1+x;if(x===-Infinity)return 0;if(x===Infinity||Number.isNaN(x))return 1+x;if(x>=1024)return Infinity;if(x<=-1075)return 0;let kd=x+SHIFT;const ki=bits(kd);kd-=SHIFT;const r=x-kd,index=2*Number(ki%128n),top=wrap64(ki<<45n),tail=fromBits(T[index]!),sbits=wrap64(T[index+1]!+top),r2=r*r,tmp=tail+r*C[0]!+r2*(C[1]!+r*C[2]!)+r2*r2*(C[3]!+r*C[4]!);if(Math.abs(x)>928)return special(tmp,sbits,ki);const scale=fromBits(sbits);return scale+scale*tmp;}
