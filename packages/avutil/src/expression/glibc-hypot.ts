// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from glibc 2.36 sysdeps/ieee754/dbl-64/e_hypot.c, non-FMA path.
// Copyright (C) 2021-2022 Free Software Foundation, Inc.
// Source: https://raw.githubusercontent.com/bminor/glibc/glibc-2.36/sysdeps/ieee754/dbl-64/e_hypot.c
// Numerical return values only; C errno and floating-point exception flags are not exposed.
const SCALE=2**-600,LARGE=2**511,TINY=2**-459,EPS=2**-54;
function kernel(ax:number,ay:number):number{let t1:number,t2:number,h=Math.sqrt(ax*ax+ay*ay);if(h<=2*ay){const delta=h-ay;t1=ax*(2*delta-ax);t2=(delta-2*(ax-ay))*delta;}else{const delta=h-ax;t1=2*delta*(ax-2*ay);t2=(4*delta-ay)*ay+delta*delta;}h-=(t1+t2)/(2*h);return h;}
export function glibcHypot(x:number,y:number):number{if(!Number.isFinite(x)||!Number.isFinite(y)){if(Math.abs(x)===Infinity||Math.abs(y)===Infinity)return Infinity;return x+y;}x=Math.abs(x);y=Math.abs(y);const ax=x<y?y:x,ay=x<y?x:y;if(ax>LARGE){if(ay<=ax*EPS)return ax+ay;return kernel(ax*SCALE,ay*SCALE)/SCALE;}if(ay<TINY){if(ax>=ay/EPS)return ax+ay;return kernel(ax/SCALE,ay/SCALE)*SCALE;}if(ay<=ax*EPS)return ax+ay;return kernel(ax,ay);}
