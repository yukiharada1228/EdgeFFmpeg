// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from FFmpeg libswscale/utils.c, initFilter, pinned commit
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2024 Niklas Haas
// Copyright (C) 2001-2003 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2011 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// TypeScript adaptation: fixed default bicubic axes, on-demand weights, bounded typed state.
// See ../LICENSES/LGPL-2.1-or-later.txt and ../NOTICE.
export interface ChromaAxis {readonly size:number;readonly taps:number;readonly positions:Int32Array;readonly coefficients:Int16Array}
const near=(n:bigint,d:bigint)=>n<0n?-((-n+d/2n)/d):(n+d/2n)/d;
/** Upper bound on typed coefficient/index storage and vertical row workspace. */
export function chromaStateBytes(sw:number,sh:number,dw:number,dh:number):number{return (sw===dw?0:28*dw)+(sh===dh?0:28*dh+24*dw);}
export function chromaAxis(src:number,dst:number,one:number,signal?:AbortSignal):ChromaAxis|null{
 if(!Number.isSafeInteger(src)||!Number.isSafeInteger(dst)||src<1||dst<1||Math.max(src,dst)>2*Math.min(src,dst)||![4096,16384].includes(one))throw new RangeError('Unsupported chroma filter axis');
 return bicubicAxis(src,dst,one,bicubicAxisBound(src,dst,one).bytes,signal);
}
/** Typed storage bound before coefficient reduction. No support-sized bigint arrays. */
export function bicubicAxisBound(src:number,dst:number,one:number,alignment?:1|2|4):{readonly bytes:number;readonly taps:number}{
 if(!Number.isInteger(src)||!Number.isInteger(dst)||src<1||dst<1||src>2147483647||dst>2147483647||![4096,16384].includes(one))throw new RangeError('Unsupported bicubic filter axis');
 if(src===dst)return {bytes:0,taps:1};
 const length=Math.max(1,Math.min(src<=dst?5:1+Math.floor((4*src+dst-1)/dst),src-2)),align=alignment??(one===16384?4:length===1?1:2),taps=Math.ceil(length/align)*align,bytes=BigInt(dst)*(4n+2n*BigInt(taps));
 if(bytes>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Bicubic filter state exceeds safe size');
 return {bytes:Number(bytes),taps};
}
/** Arbitrary fixed-default bicubic axis with explicit typed-storage preflight.
 * Scalar Native filters align to one coefficient; SIMD profiles use padded
 * filters. Padding can change error diffusion during coefficient normalization. */
export function bicubicAxis(src:number,dst:number,one:number,maxStateBytes:number,signal?:AbortSignal,alignment?:1|2|4):ChromaAxis|null{
 const bound=bicubicAxisBound(src,dst,one,alignment);
 if(!Number.isSafeInteger(maxStateBytes)||maxStateBytes<0||bound.bytes>maxStateBytes)throw new RangeError('Bicubic filter state exceeds allocation limit');
 signal?.throwIfAborted();
 if(src===dst)return null;
 const inc=(BigInt(src)*65536n+BigInt(dst>>1))/BigInt(dst),length=Math.max(1,Math.min(inc<=65536n?5:1+Math.floor((4*src+dst-1)/dst),src-2));
 const fone=1n<<BigInt(54-Math.min(31-Math.clz32(Math.max(1,Math.floor(src/dst))),8)),c=10066329n,positions=new Int32Array(dst);
 function weight(start:number,center:bigint,j:number):bigint{
   if((j&4095)===0)signal?.throwIfAborted();if(j<0||j>=length)return 0n;
   let distance=(BigInt(start+j)*131072n-center);if(distance<0n)distance=-distance;distance<<=13n;if(inc>65536n)distance=distance*BigInt(dst)/BigInt(src);
   const square=distance*distance>>30n,cube=square*distance>>30n;
   const value=distance>=1n<<31n?0n:distance<1n<<30n?(12n*(1n<<24n)-6n*c)*cube+(-18n*(1n<<24n)+6n*c)*square+6n*(1n<<54n):-6n*c*cube+30n*c*square-48n*c*distance+24n*c*(1n<<30n);
   return value/((1n<<54n)/fone);
 }
 let minimum=0;
 for(let i=dst-1;i>=0;i--){
  signal?.throwIfAborted();const center=inc-65536n+2n*BigInt(i)*inc,rawStart=Number((center-BigInt(length-2)*65536n)/131072n);let start=rawStart,left=0,cutoff=0n;
  for(let j=0;j<length;j++){const value=weight(rawStart,center,left);cutoff+=value<0n?-value:value;if(cutoff*500n>fone||i<dst-1&&start>=positions[i+1]!)break;left++;start++;}
  cutoff=0n;let remaining=length;
  for(let j=length-1;j>0;j--){const value=weight(rawStart,center,left+j);cutoff+=value<0n?-value:value;if(cutoff*500n>fone)break;remaining--;}
  positions[i]=start;minimum=Math.max(minimum,remaining);
 }
 const align=alignment??(one===16384?4:minimum===1?1:2),taps=Math.ceil(minimum/align)*align,coefficients=new Int16Array(dst*taps);
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
/** Separable Q14 horizontal -> Q7 pixels -> Q12 vertical -> byte output. */
export function chromaRow(row:number,dw:number,read:(row:number,column:number)=>number,horizontal:ChromaAxis|null,vertical:ChromaAxis|null,scratch:Int16Array,write:(column:number,value:number)=>void,signal?:AbortSignal,q6=false,output:'byte'|'q9'|'q9-round'='byte'):void{
 const count=vertical?.taps??1,start=vertical?.positions[row]??row;
 for(let j=0;j<count;j++){
  const coefficient=vertical?.coefficients[row*count+j]??4096;if(coefficient===0)continue;
  for(let x=0;x<dw;x++){
   if((x&4095)===0)signal?.throwIfAborted();let sum=0;
   if(horizontal){for(let k=0;k<horizontal.taps;k++){if((k&4095)===0)signal?.throwIfAborted();const weight=horizontal.coefficients[x*horizontal.taps+k]!;if(weight!==0)sum+=read(start+j,horizontal.positions[x]!+k)*weight;}}
   else sum=read(start+j,x)*16384;
   const value=Math.min(32767,Math.floor(sum/(q6?8192:128)));
   if(vertical)scratch[j*dw+x]=value;else write(x,output!=='byte'?value*4:Math.max(0,Math.min(255,Math.floor((value+64)/128))));
  }
 }
 if(vertical)for(let x=0;x<dw;x++){
  if((x&4095)===0)signal?.throwIfAborted();const first=vertical.coefficients[row*count]!,second=vertical.coefficients[row*count+1]??0,optimized=count===1||count===2&&first+second===4096&&second>=0&&second<=4096;let sum=output!=='byte'?(output==='q9-round'||!optimized?512:0):262144;for(let j=0;j<count;j++)sum+=scratch[j*dw+x]!*vertical.coefficients[row*count+j]!;write(x,output!=='byte'?Math.floor(sum/1024):Math.max(0,Math.min(255,Math.floor(sum/524288))));
 }
}
