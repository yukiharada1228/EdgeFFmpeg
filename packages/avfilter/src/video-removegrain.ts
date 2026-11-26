// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_removegrain.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-REMOVEGRAIN.
/** One removegrain kernel: c is the centre, a1..a8 the 3x3 neighbours in row order (a1 a2 a3 / a4 c a5 / a6 a7 a8). */
export type RemoveGrainMode=(c:number,a1:number,a2:number,a3:number,a4:number,a5:number,a6:number,a7:number,a8:number)=>number;
const min=(a:number,b:number)=>a<b?a:b,max=(a:number,b:number)=>a>b?a:b,abs=(a:number)=>a<0?-a:a;
/** av_clip(a,amin,amax); amin<=amax holds for every call site. */
const clip=(a:number,lo:number,hi:number)=>a<lo?lo:a>hi?hi:a,clipU16=(a:number)=>a<0?0:a>65535?65535:a;
/** AV_QSORT with cmp_int into a reused buffer; any correct sort of eight ints gives the same ranks. */
const sorted=new Int32Array(8);
function sort8(a1:number,a2:number,a3:number,a4:number,a5:number,a6:number,a7:number,a8:number):Int32Array{
 sorted[0]=a1;sorted[1]=a2;sorted[2]=a3;sorted[3]=a4;sorted[4]=a5;sorted[5]=a6;sorted[6]=a7;sorted[7]=a8;
 for(let i=1;i<8;i++){const v=sorted[i]!;let j=i-1;while(j>=0&&sorted[j]!>v){sorted[j+1]=sorted[j]!;j--;}sorted[j+1]=v;}
 return sorted;
}
const mode01:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>clip(c,min(min(min(a1,a2),min(a3,a4)),min(min(a5,a6),min(a7,a8))),max(max(max(a1,a2),max(a3,a4)),max(max(a5,a6),max(a7,a8))));
const mode02:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{const a=sort8(a1,a2,a3,a4,a5,a6,a7,a8);return clip(c,a[1]!,a[6]!);};
const mode03:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{const a=sort8(a1,a2,a3,a4,a5,a6,a7,a8);return clip(c,a[2]!,a[5]!);};
const mode04:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{const a=sort8(a1,a2,a3,a4,a5,a6,a7,a8);return clip(c,a[3]!,a[4]!);};
const mode05:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const ma1=max(a1,a8),mi1=min(a1,a8),ma2=max(a2,a7),mi2=min(a2,a7),ma3=max(a3,a6),mi3=min(a3,a6),ma4=max(a4,a5),mi4=min(a4,a5);
 const c1=abs(c-clip(c,mi1,ma1)),c2=abs(c-clip(c,mi2,ma2)),c3=abs(c-clip(c,mi3,ma3)),c4=abs(c-clip(c,mi4,ma4)),mindiff=min(min(c1,c2),min(c3,c4));
 // Native return order: 4, 2, 3, 1.
 return mindiff===c4?clip(c,mi4,ma4):mindiff===c2?clip(c,mi2,ma2):mindiff===c3?clip(c,mi3,ma3):clip(c,mi1,ma1);
};
/** mode06/07/08 share the axis clips and differ only in how the clip distance and the axis range are weighted. */
function weighted(c:number,a1:number,a2:number,a3:number,a4:number,a5:number,a6:number,a7:number,a8:number,cost:(distance:number,range:number)=>number):number{
 const ma1=max(a1,a8),mi1=min(a1,a8),ma2=max(a2,a7),mi2=min(a2,a7),ma3=max(a3,a6),mi3=min(a3,a6),ma4=max(a4,a5),mi4=min(a4,a5);
 const cli1=clip(c,mi1,ma1),cli2=clip(c,mi2,ma2),cli3=clip(c,mi3,ma3),cli4=clip(c,mi4,ma4);
 const c1=cost(abs(c-cli1),ma1-mi1),c2=cost(abs(c-cli2),ma2-mi2),c3=cost(abs(c-cli3),ma3-mi3),c4=cost(abs(c-cli4),ma4-mi4),mindiff=min(min(c1,c2),min(c3,c4));
 return mindiff===c4?cli4:mindiff===c2?cli2:mindiff===c3?cli3:cli1;
}
const cost06=(distance:number,range:number)=>clipU16((distance<<1)+range),cost07=(distance:number,range:number)=>distance+range,cost08=(distance:number,range:number)=>clipU16(distance+(range<<1));
const mode06:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>weighted(c,a1,a2,a3,a4,a5,a6,a7,a8,cost06);
const mode07:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>weighted(c,a1,a2,a3,a4,a5,a6,a7,a8,cost07);
const mode08:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>weighted(c,a1,a2,a3,a4,a5,a6,a7,a8,cost08);
const mode09:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const ma1=max(a1,a8),mi1=min(a1,a8),ma2=max(a2,a7),mi2=min(a2,a7),ma3=max(a3,a6),mi3=min(a3,a6),ma4=max(a4,a5),mi4=min(a4,a5);
 const d1=ma1-mi1,d2=ma2-mi2,d3=ma3-mi3,d4=ma4-mi4,mindiff=min(min(d1,d2),min(d3,d4));
 return mindiff===d4?clip(c,mi4,ma4):mindiff===d2?clip(c,mi2,ma2):mindiff===d3?clip(c,mi3,ma3):clip(c,mi1,ma1);
};
const mode10:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const d1=abs(c-a1),d2=abs(c-a2),d3=abs(c-a3),d4=abs(c-a4),d5=abs(c-a5),d6=abs(c-a6),d7=abs(c-a7),d8=abs(c-a8),mindiff=min(min(min(d1,d2),min(d3,d4)),min(min(d5,d6),min(d7,d8)));
 return mindiff===d7?a7:mindiff===d8?a8:mindiff===d6?a6:mindiff===d2?a2:mindiff===d3?a3:mindiff===d1?a1:mindiff===d5?a5:a4;
};
const mode1112:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>(4*c+2*(a2+a4+a5+a7)+a1+a3+a6+a8+8)>>4;
const mode1314:RemoveGrainMode=(_c,a1,a2,a3,_a4,_a5,a6,a7,a8)=>{
 const d1=abs(a1-a8),d2=abs(a2-a7),d3=abs(a3-a6),mindiff=min(min(d1,d2),d3);
 return mindiff===d2?(a2+a7+1)>>1:mindiff===d3?(a3+a6+1)>>1:(a1+a8+1)>>1;
};
const mode1516:RemoveGrainMode=(_c,a1,a2,a3,_a4,_a5,a6,a7,a8)=>{
 const d1=abs(a1-a8),d2=abs(a2-a7),d3=abs(a3-a6),mindiff=min(min(d1,d2),d3),average=(2*(a2+a7)+a1+a3+a6+a8+4)>>3;
 return mindiff===d2?clip(average,min(a2,a7),max(a2,a7)):mindiff===d3?clip(average,min(a3,a6),max(a3,a6)):clip(average,min(a1,a8),max(a1,a8));
};
const mode17:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const l=max(max(min(a1,a8),min(a2,a7)),max(min(a3,a6),min(a4,a5))),u=min(min(max(a1,a8),max(a2,a7)),min(max(a3,a6),max(a4,a5)));
 return clip(c,min(l,u),max(l,u));
};
const mode18:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const d1=max(abs(c-a1),abs(c-a8)),d2=max(abs(c-a2),abs(c-a7)),d3=max(abs(c-a3),abs(c-a6)),d4=max(abs(c-a4),abs(c-a5)),mindiff=min(min(d1,d2),min(d3,d4));
 return mindiff===d4?clip(c,min(a4,a5),max(a4,a5)):mindiff===d2?clip(c,min(a2,a7),max(a2,a7)):mindiff===d3?clip(c,min(a3,a6),max(a3,a6)):clip(c,min(a1,a8),max(a1,a8));
};
const mode19:RemoveGrainMode=(_c,a1,a2,a3,a4,a5,a6,a7,a8)=>(a1+a2+a3+a4+a5+a6+a7+a8+4)>>3;
/** (sum+4)/9 on a non-negative int: C division truncates, as Math.trunc does. */
const mode20:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>Math.trunc((a1+a2+a3+a4+c+a5+a6+a7+a8+4)/9);
const mode21:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const mi=min(min((a1+a8)>>1,(a2+a7)>>1),min((a3+a6)>>1,(a4+a5)>>1)),ma=max(max((a1+a8+1)>>1,(a2+a7+1)>>1),max((a3+a6+1)>>1,(a4+a5+1)>>1));
 return clip(c,mi,ma);
};
const mode22:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const l1=(a1+a8+1)>>1,l2=(a2+a7+1)>>1,l3=(a3+a6+1)>>1,l4=(a4+a5+1)>>1;
 return clip(c,min(min(l1,l2),min(l3,l4)),max(max(l1,l2),max(l3,l4)));
};
const mode23:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const ma1=max(a1,a8),mi1=min(a1,a8),ma2=max(a2,a7),mi2=min(a2,a7),ma3=max(a3,a6),mi3=min(a3,a6),ma4=max(a4,a5),mi4=min(a4,a5);
 const l1=ma1-mi1,l2=ma2-mi2,l3=ma3-mi3,l4=ma4-mi4;
 const u=max(max(max(min(c-ma1,l1),min(c-ma2,l2)),max(min(c-ma3,l3),min(c-ma4,l4))),0);
 const d=max(max(max(min(mi1-c,l1),min(mi2-c,l2)),max(min(mi3-c,l3),min(mi4-c,l4))),0);
 return c-u+d;
};
const mode24:RemoveGrainMode=(c,a1,a2,a3,a4,a5,a6,a7,a8)=>{
 const ma1=max(a1,a8),mi1=min(a1,a8),ma2=max(a2,a7),mi2=min(a2,a7),ma3=max(a3,a6),mi3=min(a3,a6),ma4=max(a4,a5),mi4=min(a4,a5);
 const l1=ma1-mi1,l2=ma2-mi2,l3=ma3-mi3,l4=ma4-mi4,tu1=c-ma1,tu2=c-ma2,tu3=c-ma3,tu4=c-ma4,td1=mi1-c,td2=mi2-c,td3=mi3-c,td4=mi4-c;
 const u=max(max(max(min(tu1,l1-tu1),min(tu2,l2-tu2)),max(min(tu3,l3-tu3),min(tu4,l4-tu4))),0);
 const d=max(max(max(min(td1,l1-td1),min(td2,l2-td2)),max(min(td3,l3-td3),min(td4,l4-td4))),0);
 return c-u+d;
};
/** config_input's mode switch: index 0 is the av_image_copy_plane path of filter_frame and has no kernel. */
export const removeGrainModes:readonly (RemoveGrainMode|null)[]=Object.freeze([null,mode01,mode02,mode03,mode04,mode05,mode06,mode07,mode08,mode09,mode10,mode1112,mode1112,mode1314,mode1314,mode1516,mode1516,mode17,mode18,mode19,mode20,mode21,mode22,mode23,mode24]);
/** config_input sets skip_odd for modes 13/15 and skip_even for 14/16 on any of the format's planes; both flags then apply to every
 * filtered plane of the frame, whatever its own mode. Modes of planes the format does not have are never read. */
export function removeGrainSkips(modes:readonly number[],planes:number):{readonly odd:boolean;readonly even:boolean}{
 const used=modes.slice(0,planes);return {odd:used.some(mode=>mode===13||mode===15),even:used.some(mode=>mode===14||mode===16)};
}
/** filter_frame plus filter_slice for one plane of a tight output: rows 0 and height-1 and columns 0 and width-1 are copied, every
 * other sample takes the kernel of its 3x3 neighbourhood unless the row is skipped. The output byte is the low eight bits of the
 * kernel result, as the uint8_t store keeps them. Slices only partition rows, so the result does not depend on threads. */
export function removeGrainPlane(src:Uint8Array,stride:number,dst:Uint8Array,offset:number,width:number,height:number,mode:number,skips:{readonly odd:boolean;readonly even:boolean},signal?:AbortSignal):void{
 const rg=removeGrainModes[mode];
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const row=y*stride,target=offset+y*width;
  if(!rg||y===0||y===height-1||(skips.even&&!(y&1))||(skips.odd&&(y&1))){dst.set(src.subarray(row,row+width),target);continue;}
  // Width 1 and 2 rows are copies: native's trailing dst[0]=src[0] lands past a one-sample row, in the output's padding.
  dst[target]=src[row]!;if(width>1)dst[target+width-1]=src[row+width-1]!;
  const up=row-stride,down=row+stride;
  for(let x=1;x<width-1;x++){
   if((x&16383)===0)signal?.throwIfAborted();
   dst[target+x]=rg(src[row+x]!,src[up+x-1]!,src[up+x]!,src[up+x+1]!,src[row+x-1]!,src[row+x+1]!,src[down+x-1]!,src[down+x]!,src[down+x+1]!)&255;
  }
 }
}
