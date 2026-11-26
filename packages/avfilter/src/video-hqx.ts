// SPDX-License-Identifier: LGPL-2.1-or-later
// RGB-to-YUV key, difference thresholds, interpolation helpers, hq2x/hq3x/hq4x pattern tables, edge replication,
// scale option and pixel format adapted from pinned FFmpeg libavfilter/vf_hqx.c at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-HQX.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
export class VideoHqxError extends Error {}
export interface VideoHqxSettings {readonly n:2|3|4}
export interface VideoHqxOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** FILTER_SINGLE_PIXFMT(AV_PIX_FMT_RGB32): bgra on little-endian hosts, read as native-endian 0xAARRGGBB words. */
export const hqxPixelFormats:readonly string[]=Object.freeze(['bgra']);
/** RGB32 is argb on big-endian hosts; those are refused rather than given the little-endian list. */
const littleEndian=new Uint8Array(Uint32Array.of(1).buffer)[0]===1;
/** AV_OPT_TYPE_INT n in [2,4], default 3; only plain decimal values are implemented. hqx has no timeline. */
export function parseHqxOptions(options:string|null):VideoHqxSettings{
 let n:2|3|4=3;
 for(const option of filterOptions(options,['n'])){
  if(option.key==='n'){if(!/^[+]?0*[0-9]+$/.test(option.value))throw new VideoHqxError('Only decimal integer hqx scale factors are implemented');const value=Number(option.value);if(value!==2&&value!==3&&value!==4)throw new VideoHqxError('hqx scale factor n must be 2, 3 or 4');n=value;}
  else if(option.key==='enable')throw new VideoHqxError('hqx does not support timeline expressions');
  else throw new VideoHqxError('Unsupported hqx option');
 }
 return Object.freeze({n});
}
/** config_output: w*n by h*n; sizes above the av_image_check_size bound of the output buffer are refused. */
export function hqxGeometry(pixelFormat:string,width:number,height:number,settings:VideoHqxSettings):{readonly width:number;readonly height:number}{
 if(!littleEndian)throw new VideoHqxError('hqx is not implemented on big-endian hosts');
 const format=pixelLayout(pixelFormat,width,height).pixelFormat;if(!hqxPixelFormats.includes(format))throw new VideoHqxError('hqx pixel format is not supported');
 const {n}=settings;if(n!==2&&n!==3&&n!==4)throw new VideoHqxError('Invalid hqx settings');
 const w=width*n,h=height*n;if((w+128)*(h+128)>=Math.floor(2147483647/8))throw new VideoHqxError('hqx output size is invalid');
 return Object.freeze({width:w,height:h});
}
/** init's 2^24-entry rgbtoyuv table, evaluated per colour 0xRRGGBB: the table walks g upwards from startg with y++, so the
 * truncated quotient is taken at startg; u and v wrap as uint32 and the packed sum is taken modulo 2^32, as native stores it. */
export function hqxRgbToYuv(c:number):number{
 const r=c>>>16&255,g=c>>>8&255,b=c&255,rg=r-g,bg=b-g,start=Math.max(-bg,-rg,0);
 const y=Math.trunc((299*rg+1000*start+114*bg)/1000)+g-start,u=Math.trunc((-169*rg+500*bg)/1000)+128,v=Math.trunc((500*rg-81*bg)/1000)+128;
 return (y*65536+u*256+v)>>>0;
}
/** yuv_diff: thresholds 48, 7 and 6 on the masked fields of the packed keys. */
const differs=(a:number,b:number)=>Math.abs((a&0xff0000)-(b&0xff0000))>48<<16||Math.abs((a&0xff00)-(b&0xff00))>7<<8||Math.abs((a&0xff)-(b&0xff))>6;
/** interp_2px and interp_3px on whole 32-bit words, alpha included: two 16-bit lanes per mask, weights summing to 1<<s. */
const i2=(c1:number,w1:number,c2:number,w2:number,s:number)=>((((c1&0xff00ff00)>>>8)*w1+((c2&0xff00ff00)>>>8)*w2)<<(8-s)&0xff00ff00|((c1&0x00ff00ff)*w1+(c2&0x00ff00ff)*w2)>>>s&0x00ff00ff)>>>0;
const i3=(c1:number,w1:number,c2:number,w2:number,c3:number,w3:number,s:number)=>((((c1&0xff00ff00)>>>8)*w1+((c2&0xff00ff00)>>>8)*w2+((c3&0xff00ff00)>>>8)*w3)<<(8-s)&0xff00ff00|((c1&0x00ff00ff)*w1+(c2&0x00ff00ff)*w2+(c3&0x00ff00ff)*w3)>>>s&0x00ff00ff)>>>0;
/** INTERP_BOOTSTRAP's k_shuffled for one neighbourhood permutation, tabulated over the 256 masks: SHF moves bit DROP4(n)
 * (7-DROP4(n) when rotated) of k to DROP4(p<n>). */
const drop4=(z:number)=>z>4?z-1:z;
function shuffle(p:readonly number[],rot:boolean):Uint8Array{
 const table=new Uint8Array(256);
 for(let k=0;k<256;k++){let value=0;for(const n of [0,1,2,3,5,6,7,8])value|=(k>>(rot?7-drop4(n):drop4(n))&1)<<drop4(p[n]!);table[k]=value;}
 return table;
}
interface Variant {readonly p:readonly number[];readonly shuffled:Uint8Array;readonly at:readonly (readonly [number,number])[]}
/** The hqx_filter call sites: neighbourhood permutation, rotate flag and the output (row, column) of each dst<pos>. */
const variant=(p:readonly number[],rot:boolean,at:readonly (readonly [number,number])[]):Variant=>Object.freeze({p:Object.freeze([...p]),shuffled:shuffle(p,rot),at:Object.freeze(at.map(cell=>Object.freeze([...cell] as const)))});
const id=[0,1,2,3,4,5,6,7,8],vmirror=[2,1,0,5,4,3,8,7,6],hmirror=[6,7,8,3,4,5,0,1,2],center=[8,7,6,5,4,3,2,1,0];
const hq2=[variant(id,false,[[0,0]]),variant(vmirror,false,[[0,1]]),variant(hmirror,false,[[1,0]]),variant(center,false,[[1,1]])];
const hq3=[variant(id,false,[[0,0],[0,1]]),variant([2,5,8,1,4,7,0,3,6],true,[[0,2],[1,2]]),variant([6,3,0,7,4,1,8,5,2],true,[[2,0],[1,0]]),variant(center,false,[[2,2],[2,1]])];
const hq4=[variant(id,false,[[0,0],[0,1],[1,0],[1,1]]),variant(vmirror,false,[[0,3],[0,2],[1,3],[1,2]]),variant(hmirror,false,[[3,0],[3,1],[2,0],[2,1]]),variant(center,false,[[3,3],[3,2],[2,3],[2,2]])];
/** hq2x_interp_1x1. */
function hq2x(k:number,W:Uint32Array,Y:Uint32Array,p:readonly number[]):number{
 const P=(m:number,r:number)=>(k&m)===r,w0=W[p[0]!]!,w1=W[p[1]!]!,w3=W[p[3]!]!,w4=W[p[4]!]!,y1=Y[p[1]!]!,y3=Y[p[3]!]!,y5=Y[p[5]!]!,y7=Y[p[7]!]!;
 if((P(0xbf,0x37)||P(0xdb,0x13))&&differs(y1,y5))return i2(w4,3,w3,1,2);
 if((P(0xdb,0x49)||P(0xef,0x6d))&&differs(y7,y3))return i2(w4,3,w1,1,2);
 if((P(0x0b,0x0b)||P(0xfe,0x4a)||P(0xfe,0x1a))&&differs(y3,y1))return w4;
 if((P(0x6f,0x2a)||P(0x5b,0x0a)||P(0xbf,0x3a)||P(0xdf,0x5a)||P(0x9f,0x8a)||P(0xcf,0x8a)||P(0xef,0x4e)||P(0x3f,0x0e)||P(0xfb,0x5a)||P(0xbb,0x8a)||P(0x7f,0x5a)||P(0xaf,0x8a)||P(0xeb,0x8a))&&differs(y3,y1))return i2(w4,3,w0,1,2);
 if(P(0x0b,0x08))return i3(w4,2,w0,1,w1,1,2);
 if(P(0x0b,0x02))return i3(w4,2,w0,1,w3,1,2);
 if(P(0x2f,0x2f))return i3(w4,14,w3,1,w1,1,4);
 if(P(0xbf,0x37)||P(0xdb,0x13))return i3(w4,5,w1,2,w3,1,3);
 if(P(0xdb,0x49)||P(0xef,0x6d))return i3(w4,5,w3,2,w1,1,3);
 if(P(0x1b,0x03)||P(0x4f,0x43)||P(0x8b,0x83)||P(0x6b,0x43))return i2(w4,3,w3,1,2);
 if(P(0x4b,0x09)||P(0x8b,0x89)||P(0x1f,0x19)||P(0x3b,0x19))return i2(w4,3,w1,1,2);
 if(P(0x7e,0x2a)||P(0xef,0xab)||P(0xbf,0x8f)||P(0x7e,0x0e))return i3(w4,2,w3,3,w1,3,3);
 if(P(0xfb,0x6a)||P(0x6f,0x6e)||P(0x3f,0x3e)||P(0xfb,0xfa)||P(0xdf,0xde)||P(0xdf,0x1e))return i2(w4,3,w0,1,2);
 if(P(0x0a,0x00)||P(0x4f,0x4b)||P(0x9f,0x1b)||P(0x2f,0x0b)||P(0xbe,0x0a)||P(0xee,0x0a)||P(0x7e,0x0a)||P(0xeb,0x4b)||P(0x3b,0x1b))return i3(w4,2,w3,1,w1,1,2);
 return i3(w4,6,w3,1,w1,1,3);
}
/** hq3x_interp_2x1: the corner (dst00) and edge (dst01) pixels of one outline couple. */
function hq3x(k:number,W:Uint32Array,Y:Uint32Array,p:readonly number[],out:Uint32Array):void{
 const P=(m:number,r:number)=>(k&m)===r,w0=W[p[0]!]!,w1=W[p[1]!]!,w3=W[p[3]!]!,w4=W[p[4]!]!,y1=Y[p[1]!]!,y3=Y[p[3]!]!,y5=Y[p[5]!]!,y7=Y[p[7]!]!;
 if((P(0xdb,0x49)||P(0xef,0x6d))&&differs(y7,y3))out[0]=i2(w4,3,w1,1,2);
 else if((P(0xbf,0x37)||P(0xdb,0x13))&&differs(y1,y5))out[0]=i2(w4,3,w3,1,2);
 else if((P(0x0b,0x0b)||P(0xfe,0x4a)||P(0xfe,0x1a))&&differs(y3,y1))out[0]=w4;
 else if((P(0x6f,0x2a)||P(0x5b,0x0a)||P(0xbf,0x3a)||P(0xdf,0x5a)||P(0x9f,0x8a)||P(0xcf,0x8a)||P(0xef,0x4e)||P(0x3f,0x0e)||P(0xfb,0x5a)||P(0xbb,0x8a)||P(0x7f,0x5a)||P(0xaf,0x8a)||P(0xeb,0x8a))&&differs(y3,y1))out[0]=i2(w4,3,w0,1,2);
 else if(P(0x4b,0x09)||P(0x8b,0x89)||P(0x1f,0x19)||P(0x3b,0x19))out[0]=i2(w4,3,w1,1,2);
 else if(P(0x1b,0x03)||P(0x4f,0x43)||P(0x8b,0x83)||P(0x6b,0x43))out[0]=i2(w4,3,w3,1,2);
 else if(P(0x7e,0x2a)||P(0xef,0xab)||P(0xbf,0x8f)||P(0x7e,0x0e))out[0]=i2(w3,1,w1,1,1);
 else if(P(0x4f,0x4b)||P(0x9f,0x1b)||P(0x2f,0x0b)||P(0xbe,0x0a)||P(0xee,0x0a)||P(0x7e,0x0a)||P(0xeb,0x4b)||P(0x3b,0x1b))out[0]=i3(w4,2,w3,7,w1,7,4);
 else if(P(0x0b,0x08)||P(0xf9,0x68)||P(0xf3,0x62)||P(0x6d,0x6c)||P(0x67,0x66)||P(0x3d,0x3c)||P(0x37,0x36)||P(0xf9,0xf8)||P(0xdd,0xdc)||P(0xf3,0xf2)||P(0xd7,0xd6)||P(0xdd,0x1c)||P(0xd7,0x16)||P(0x0b,0x02))out[0]=i2(w4,3,w0,1,2);
 else out[0]=i3(w4,2,w3,1,w1,1,2);
 if((P(0xfe,0xde)||P(0x9e,0x16)||P(0xda,0x12)||P(0x17,0x16)||P(0x5b,0x12)||P(0xbb,0x12))&&differs(y1,y5))out[1]=w4;
 else if((P(0x0f,0x0b)||P(0x5e,0x0a)||P(0xfb,0x7b)||P(0x3b,0x0b)||P(0xbe,0x0a)||P(0x7a,0x0a))&&differs(y3,y1))out[1]=w4;
 else if(P(0xbf,0x8f)||P(0x7e,0x0e)||P(0xbf,0x37)||P(0xdb,0x13))out[1]=i2(w1,3,w4,1,2);
 else if(P(0x02,0x00)||P(0x7c,0x28)||P(0xed,0xa9)||P(0xf5,0xb4)||P(0xd9,0x90))out[1]=i2(w4,3,w1,1,2);
 else if(P(0x4f,0x4b)||P(0xfb,0x7b)||P(0xfe,0x7e)||P(0x9f,0x1b)||P(0x2f,0x0b)||P(0xbe,0x0a)||P(0x7e,0x0a)||P(0xfb,0x4b)||P(0xfb,0xdb)||P(0xfe,0xde)||P(0xfe,0x56)||P(0x57,0x56)||P(0x97,0x16)||P(0x3f,0x1e)||P(0xdb,0x12)||P(0xbb,0x12))out[1]=i2(w4,7,w1,1,3);
 else out[1]=w4;
}
/** hq4x_interp_2x2: one 2x2 block of the 4x4 output (dst00, dst01, dst10, dst11). */
function hq4x(k:number,W:Uint32Array,Y:Uint32Array,p:readonly number[],out:Uint32Array):void{
 const P=(m:number,r:number)=>(k&m)===r,w0=W[p[0]!]!,w1=W[p[1]!]!,w3=W[p[3]!]!,w4=W[p[4]!]!,y1=Y[p[1]!]!,y3=Y[p[3]!]!,y5=Y[p[5]!]!,y7=Y[p[7]!]!;
 const cond00=(P(0xbf,0x37)||P(0xdb,0x13))&&differs(y1,y5),cond01=(P(0xdb,0x49)||P(0xef,0x6d))&&differs(y7,y3);
 const cond02=(P(0x6f,0x2a)||P(0x5b,0x0a)||P(0xbf,0x3a)||P(0xdf,0x5a)||P(0x9f,0x8a)||P(0xcf,0x8a)||P(0xef,0x4e)||P(0x3f,0x0e)||P(0xfb,0x5a)||P(0xbb,0x8a)||P(0x7f,0x5a)||P(0xaf,0x8a)||P(0xeb,0x8a))&&differs(y3,y1);
 const cond03=P(0xdb,0x49)||P(0xef,0x6d),cond04=P(0xbf,0x37)||P(0xdb,0x13),cond05=P(0x1b,0x03)||P(0x4f,0x43)||P(0x8b,0x83)||P(0x6b,0x43),cond06=P(0x4b,0x09)||P(0x8b,0x89)||P(0x1f,0x19)||P(0x3b,0x19);
 const cond07=P(0x0b,0x08)||P(0xf9,0x68)||P(0xf3,0x62)||P(0x6d,0x6c)||P(0x67,0x66)||P(0x3d,0x3c)||P(0x37,0x36)||P(0xf9,0xf8)||P(0xdd,0xdc)||P(0xf3,0xf2)||P(0xd7,0xd6)||P(0xdd,0x1c)||P(0xd7,0x16)||P(0x0b,0x02);
 const cond08=(P(0x0f,0x0b)||P(0x2b,0x0b)||P(0xfe,0x4a)||P(0xfe,0x1a))&&differs(y3,y1),cond09=P(0x2f,0x2f),cond10=P(0x0a,0x00),cond11=P(0x0b,0x09),cond12=P(0x7e,0x2a)||P(0xef,0xab),cond13=P(0xbf,0x8f)||P(0x7e,0x0e);
 const cond14=P(0x4f,0x4b)||P(0x9f,0x1b)||P(0x2f,0x0b)||P(0xbe,0x0a)||P(0xee,0x0a)||P(0x7e,0x0a)||P(0xeb,0x4b)||P(0x3b,0x1b),cond15=P(0x0b,0x03);
 if(cond00)out[0]=i2(w4,5,w3,3,3);
 else if(cond01)out[0]=i2(w4,5,w1,3,3);
 else if((P(0x0b,0x0b)||P(0xfe,0x4a)||P(0xfe,0x1a))&&differs(y3,y1))out[0]=w4;
 else if(cond02)out[0]=i2(w4,5,w0,3,3);
 else if(cond03)out[0]=i2(w4,3,w3,1,2);
 else if(cond04)out[0]=i2(w4,3,w1,1,2);
 else if(cond05)out[0]=i2(w4,5,w3,3,3);
 else if(cond06)out[0]=i2(w4,5,w1,3,3);
 else if(P(0x0f,0x0b)||P(0x5e,0x0a)||P(0x2b,0x0b)||P(0xbe,0x0a)||P(0x7a,0x0a)||P(0xee,0x0a))out[0]=i2(w1,1,w3,1,1);
 else if(cond07)out[0]=i2(w4,5,w0,3,3);
 else out[0]=i3(w4,2,w1,1,w3,1,2);
 if(cond00)out[1]=i2(w4,7,w3,1,3);
 else if(cond08)out[1]=w4;
 else if(cond02)out[1]=i2(w4,3,w0,1,2);
 else if(cond09)out[1]=w4;
 else if(cond10)out[1]=i3(w4,5,w1,2,w3,1,3);
 else if(P(0x0b,0x08))out[1]=i3(w4,5,w1,2,w0,1,3);
 else if(cond11)out[1]=i2(w4,5,w1,3,3);
 else if(cond04)out[1]=i2(w1,3,w4,1,2);
 else if(cond12)out[1]=i3(w1,2,w4,1,w3,1,2);
 else if(cond13)out[1]=i2(w1,5,w3,3,3);
 else if(cond05)out[1]=i2(w4,7,w3,1,3);
 else if(P(0xf3,0x62)||P(0x67,0x66)||P(0x37,0x36)||P(0xf3,0xf2)||P(0xd7,0xd6)||P(0xd7,0x16)||P(0x0b,0x02))out[1]=i2(w4,3,w0,1,2);
 else if(cond14)out[1]=i2(w1,1,w4,1,1);
 else out[1]=i2(w4,3,w1,1,2);
 if(cond01)out[2]=i2(w4,7,w1,1,3);
 else if(cond08)out[2]=w4;
 else if(cond02)out[2]=i2(w4,3,w0,1,2);
 else if(cond09)out[2]=w4;
 else if(cond10)out[2]=i3(w4,5,w3,2,w1,1,3);
 else if(P(0x0b,0x02))out[2]=i3(w4,5,w3,2,w0,1,3);
 else if(cond15)out[2]=i2(w4,5,w3,3,3);
 else if(cond03)out[2]=i2(w3,3,w4,1,2);
 else if(cond13)out[2]=i3(w3,2,w4,1,w1,1,2);
 else if(cond12)out[2]=i2(w3,5,w1,3,3);
 else if(cond06)out[2]=i2(w4,7,w1,1,3);
 else if(P(0x0b,0x08)||P(0xf9,0x68)||P(0x6d,0x6c)||P(0x3d,0x3c)||P(0xf9,0xf8)||P(0xdd,0xdc)||P(0xdd,0x1c))out[2]=i2(w4,3,w0,1,2);
 else if(cond14)out[2]=i2(w3,1,w4,1,1);
 else out[2]=i2(w4,3,w3,1,2);
 if((P(0x7f,0x2b)||P(0xef,0xab)||P(0xbf,0x8f)||P(0x7f,0x0f))&&differs(y3,y1))out[3]=w4;
 else if(cond02)out[3]=i2(w4,7,w0,1,3);
 else if(cond15)out[3]=i2(w4,7,w3,1,3);
 else if(cond11)out[3]=i2(w4,7,w1,1,3);
 else if(P(0x0a,0x00)||P(0x7e,0x2a)||P(0xef,0xab)||P(0xbf,0x8f)||P(0x7e,0x0e))out[3]=i3(w4,6,w3,1,w1,1,3);
 else if(cond07)out[3]=i2(w4,7,w0,1,3);
 else out[3]=w4;
}
/** hqx_filter over the whole frame (slices are row-independent) into owned tight planes; output bytes are bounded by maxFrameBytes. */
export function hqxVideoFrame(frame:VideoFrameData,settings:VideoHqxSettings,options:VideoHqxOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {width,height}=frame,size=hqxGeometry(frame.pixelFormat,width,height,settings),n=settings.n,layout=pixelLayout(frame.pixelFormat,size.width,size.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoHqxError('hqx frame exceeds allocation limit');
 const input=frame.planes[0],stride=frame.linesizes[0],rowBytes=width*4;
 if(frame.planes.length!==1||frame.linesizes.length!==1)throw new VideoHqxError('Invalid hqx plane count');
 if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(height-1)+BigInt(rowBytes))throw new VideoHqxError('Invalid hqx plane stride or storage');
 if(input.length>maxFrameBytes)throw new VideoHqxError('hqx input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoHqxError('Invalid hqx timestamp time base');
 // Tight native-endian 32-bit words, as native reads RGB32 through uint32_t pointers; their keys are computed once per pixel.
 const src=new Uint32Array(width*height),srcBytes=new Uint8Array(src.buffer),key=new Uint32Array(width*height);
 for(let y=0;y<height;y++){signal?.throwIfAborted();srcBytes.set(input.subarray(y*stride!,y*stride!+rowBytes),y*rowBytes);}
 for(let i=0;i<src.length;i++)key[i]=hqxRgbToYuv(src[i]!&0xffffff);
 const outWidth=size.width,dst=new Uint32Array(outWidth*size.height),W=new Uint32Array(9),Y=new Uint32Array(9),cell=new Uint32Array(4),last=width-1;
 const variants=n===2?hq2:n===3?hq3:hq4;
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const top=(y>0?y-1:y)*width,mid=y*width,bottom=(y<height-1?y+1:y)*width,row=y*n*outWidth;
  for(let x=0;x<width;x++){
   if((x&4095)===0)signal?.throwIfAborted();const l=x>0?x-1:x,r=x<last?x+1:x;
   const at=[top+l,top+x,top+r,mid+l,mid+x,mid+r,bottom+l,bottom+x,bottom+r];
   for(let i=0;i<9;i++){W[i]=src[at[i]!]!;Y[i]=key[at[i]!]!;}
   const w4=W[4]!,y4=Y[4]!;let pattern=0;
   for(let i=0,bit=0;i<9;i++){if(i===4)continue;if(w4!==W[i]&&differs(y4,Y[i]!))pattern|=1<<bit;bit++;}
   const o=row+x*n;
   for(const {p,shuffled,at:cells}of variants){
    const k=shuffled[pattern]!;
    if(n===2){dst[o+cells[0]![0]*outWidth+cells[0]![1]]=hq2x(k,W,Y,p);continue;}
    if(n===3)hq3x(k,W,Y,p,cell);else hq4x(k,W,Y,p,cell);
    for(const [index,[cy,cx]]of cells.entries())dst[o+cy*outWidth+cx]=cell[index]!;
   }
   if(n===3)dst[o+outWidth+1]=w4;
  }
 }
 const data=new Uint8Array(dst.buffer);
 return {width:size.width,height:size.height,pixelFormat:layout.pixelFormat,planes:[data],linesizes:[layout.planes[0]!.rowBytes],pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
