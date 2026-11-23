// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from FFmpeg libswscale/utils.c, initFilter, pinned commit
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2024 Niklas Haas
// Copyright (C) 2001-2003 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2011 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// TypeScript adaptation: bilinear axes, on-demand weights, bounded typed state.
// See ../../LICENSES/LGPL-2.1-or-later.txt and ../../NOTICE.
export interface ChromaAxis {readonly size:number;readonly taps:number;readonly positions:Int32Array;readonly coefficients:Int16Array}
const near=(n:bigint,d:bigint)=>n<0n?-((-n+d/2n)/d):(n+d/2n)/d;
/** Upper bound on typed coefficient/index storage and vertical row workspace. */
export function chromaStateBytes(sw:number,sh:number,dw:number,dh:number):number{return (sw===dw?0:28*dw)+(sh===dh?0:28*dh+24*dw);}
export function chromaAxis(src:number,dst:number,one:number,signal?:AbortSignal):ChromaAxis|null{
 if(!Number.isSafeInteger(src)||!Number.isSafeInteger(dst)||src<1||dst<1||Math.max(src,dst)>2*Math.min(src,dst)||![4096,16384].includes(one))throw new RangeError('Unsupported chroma filter axis');
 return bilinearAxis(src,dst,one,bilinearAxisBound(src,dst,one).bytes,signal);
}
/** Typed storage bound before coefficient reduction. No support-sized bigint arrays. */
export function bilinearAxisBound(src:number,dst:number,one:number):{readonly bytes:number;readonly taps:number}{
 if(!Number.isInteger(src)||!Number.isInteger(dst)||src<1||dst<1||src>2147483647||dst>2147483647||![4096,16384].includes(one))throw new RangeError('Unsupported bilinear filter axis');
 if(src===dst)return {bytes:0,taps:1};
 const length=Math.max(1,Math.min(src<=dst?3:1+Math.floor((2*src+dst-1)/dst),src-2)),align=one===16384?4:length===1?1:2,taps=Math.ceil(length/align)*align,bytes=BigInt(dst)*(4n+2n*BigInt(taps));
 if(bytes>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Bilinear filter state exceeds safe size');
 return {bytes:Number(bytes),taps};
}
/** Arbitrary bilinear axis with explicit typed-storage preflight. */
export function bilinearAxis(src:number,dst:number,one:number,maxStateBytes:number,signal?:AbortSignal):ChromaAxis|null{
 const bound=bilinearAxisBound(src,dst,one);
 if(!Number.isSafeInteger(maxStateBytes)||maxStateBytes<0||bound.bytes>maxStateBytes)throw new RangeError('Bilinear filter state exceeds allocation limit');
 signal?.throwIfAborted();
 if(src===dst)return null;
 const inc=(BigInt(src)*65536n+BigInt(dst>>1))/BigInt(dst),length=Math.max(1,Math.min(inc<=65536n?3:1+Math.floor((2*src+dst-1)/dst),src-2));
 const fone=1n<<BigInt(54-Math.min(31-Math.clz32(Math.max(1,Math.floor(src/dst))),8)),positions=new Int32Array(dst);
 function weight(start:number,center:bigint,j:number):bigint{
   if((j&4095)===0)signal?.throwIfAborted();if(j<0||j>=length)return 0n;
   let distance=(BigInt(start+j)*131072n-center);if(distance<0n)distance=-distance;distance<<=13n;if(inc>65536n)distance=distance*BigInt(dst)/BigInt(src);
   const value=(1n<<30n)-distance;return value>0n?value*(fone>>30n):0n;
 }
 if(inc>65526n&&inc<65546n){const coefficients=new Int16Array(dst);for(let i=0;i<dst;i++){if((i&4095)===0)signal?.throwIfAborted();positions[i]=Math.min(src-1,i);coefficients[i]=one;}return {size:dst,taps:1,positions,coefficients};}
 let minimum=0;
 for(let i=dst-1;i>=0;i--){
  signal?.throwIfAborted();const center=inc-65536n+2n*BigInt(i)*inc,rawStart=Number((center-BigInt(length-2)*65536n)/131072n);let start=rawStart,left=0,cutoff=0n;
  for(let j=0;j<length;j++){const value=weight(rawStart,center,left);cutoff+=value<0n?-value:value;if(cutoff*500n>fone||i<dst-1&&start>=positions[i+1]!)break;left++;start++;}
  cutoff=0n;let remaining=length;
  for(let j=length-1;j>0;j--){const value=weight(rawStart,center,left+j);cutoff+=value<0n?-value:value;if(cutoff*500n>fone)break;remaining--;}
  positions[i]=start;minimum=Math.max(minimum,remaining);
 }
 const align=one===16384?4:minimum===1?1:2,taps=Math.ceil(minimum/align)*align,coefficients=new Int16Array(dst*taps);
 for(let i=0;i<dst;i++){
  signal?.throwIfAborted();const center=inc-65536n+2n*BigInt(i)*inc,start=Number((center-BigInt(length-2)*65536n)/131072n),trimmed=positions[i]!,left=trimmed-start;
  const first=Math.max(0,Math.min(trimmed,src-taps)),last=Math.min(src-1,first+taps-1);let total=0n;
  for(let j=0;j<taps;j++)total+=weight(start,center,left+j);
  let sum=(total+BigInt(one>>1))/BigInt(one);if(sum===0n)sum=1n;let error=0n,k=0;
  for(let position=first;position<=last;position++){
   let folded=0n;
   while(k<taps&&Math.max(0,Math.min(src-1,trimmed+k))===position){folded+=weight(start,center,left+k);k++;}
   const value=folded+error,coefficient=near(value,sum);coefficients[i*taps+position-first]=Number(coefficient);error=value-coefficient*sum;
  }
  positions[i]=first;
 }
 return {size:dst,taps,positions,coefficients};
}
