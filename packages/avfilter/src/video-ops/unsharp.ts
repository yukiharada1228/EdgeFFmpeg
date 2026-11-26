// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_unsharp.c (8-bit unsharp_slice, set_filter_param, init_filter_param). See ../../NOTICE-UNSHARP.
import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoUnsharpError extends Error {}
/** One UnsharpFilterParam: odd-or-even matrix size as given and amount*65536.0 truncated to int. */
export interface UnsharpPlaneParam {readonly msizeX:number;readonly msizeY:number;readonly amount:number}
export type UnsharpStep={readonly name:'unsharp';readonly luma:UnsharpPlaneParam;readonly chroma:UnsharpPlaneParam;readonly alpha:UnsharpPlaneParam};
/** The pinned vf_unsharp.c pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is
 * refused at plan time. */
export const unsharpPixelFormats:readonly string[]=Object.freeze('yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le yuv420p yuv422p yuv444p yuv410p yuv411p yuv440p yuvj420p yuvj422p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p16le yuv422p16le yuv444p16le yuvj444p yuvj440p'.split(' '));
/** The eight-bit members with frame storage here: yuva420p, yuv420p, yuv422p and yuv444p (legacy yuvj links reach frames as these). */
const executable:readonly string[]=Object.freeze(unsharpPixelFormats.filter(executableFormat));
/** AVOption order with the alias that shares each offset; positional values skip aliases. */
const keys=[['luma_msize_x','lx'],['luma_msize_y','ly'],['luma_amount','la'],['chroma_msize_x','cx'],['chroma_msize_y','cy'],['chroma_amount','ca'],['alpha_msize_x','ax'],['alpha_msize_y','ay'],['alpha_amount','aa']] as const;
const MAX_SCALEBITS=25;
/** AV_OPT_TYPE_FLOAT in [-2,5]: the double is range-checked, stored as float, and set_filter_param truncates amount*65536.0 to int.
 * Only decimal literals are implemented. */
function amountValue(text:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new VideoFilterParseError('Only decimal unsharp amount values are implemented');
 const value=Number(text);if(!(value>=-2&&value<=5))throw new VideoFilterParseError('Unsharp amount must be within [-2,5]');
 return Math.trunc(Math.fround(value)*65536)||0;
}
const steps=(param:UnsharpPlaneParam)=>({x:param.msizeX>>1,y:param.msizeY>>1});
/** init's set_filter_param for luma, chroma and alpha, then config_input's odd-size check for luma and chroma (alpha is never checked). */
function checkParams(luma:UnsharpPlaneParam,chroma:UnsharpPlaneParam,alpha:UnsharpPlaneParam,error:(message:string)=>Error):void{
 for(const [name,short,param]of [['luma','l',luma],['chroma','c',chroma],['alpha','a',alpha]] as const){const {x,y}=steps(param),scalebits=(x+y)*2;if(scalebits>MAX_SCALEBITS)throw error(`${name} matrix size (${short}x/2+${short}y/2)*2=${scalebits} greater than maximum value ${MAX_SCALEBITS}`);}
 for(const [name,param]of [['luma',luma],['chroma',chroma]] as const)if(!(param.msizeX&param.msizeY&1))throw error(`Invalid even size for ${name} matrix size ${param.msizeX}x${param.msizeY}`);
}
export function parseUnsharpOptions(options:string|null):UnsharpStep{
 const values=[5,5,65536,5,5,0,5,5,0];
 for(const option of filterOptions(options,keys.map(pair=>pair[0]))){
  const index=keys.findIndex(pair=>(pair as readonly string[]).includes(option.key));
  if(index<0){if(option.key==='enable')throw new VideoFilterParseError('Unsharp timeline expressions are not implemented');throw new VideoFilterParseError('Unsupported unsharp option');}
  if(index%3===2){values[index]=amountValue(option.value);continue;}
  try{values[index]=filterIntegerOption(option.value,{min:3,max:23,defaultValue:5});}catch(error){throw new VideoFilterParseError('Invalid unsharp matrix size: '+(error as Error).message);}
 }
 const param=(offset:number):UnsharpPlaneParam=>Object.freeze({msizeX:values[offset]!,msizeY:values[offset+1]!,amount:values[offset+2]!});
 const luma=param(0),chroma=param(3),alpha=param(6);checkParams(luma,chroma,alpha,message=>new VideoFilterParseError(message));
 return Object.freeze({name:'unsharp',luma,chroma,alpha});
}
const validParam=(param:UnsharpPlaneParam)=>param!==null&&typeof param==='object'&&Number.isInteger(param.msizeX)&&param.msizeX>=3&&param.msizeX<=23&&Number.isInteger(param.msizeY)&&param.msizeY>=3&&param.msizeY<=23&&Number.isInteger(param.amount)&&param.amount>=-131072&&param.amount<=327680;
function checkStep(step:UnsharpStep):void{
 if(step?.name!=='unsharp'||![step.luma,step.chroma,step.alpha].every(validParam))throw new VideoUnsharpError('Invalid unsharp settings');
 checkParams(step.luma,step.chroma,step.alpha,()=>new VideoUnsharpError('Invalid unsharp settings'));
}
/** Native never initialises the alpha FSM storage (init_filter_param runs for luma and chroma only), so a nonzero alpha amount on a
 * format with alpha dereferences a null row table. */
function validate(format:string,step:UnsharpStep):string{
 const pixelFormat=videoStoragePixelFormat(format);checkStep(step);if(!executable.includes(pixelFormat))throw new VideoUnsharpError('Unsharp pixel format is not supported');
 if(step.alpha.amount!==0&&pixelFormat==='yuva420p')throw new VideoUnsharpError('Unsharp nonzero alpha amounts are not implemented: native alpha storage is never allocated');
 return pixelFormat;
}
/** config_input sets nb_threads to h/(4*luma steps_y); at zero, ff_filter_execute runs no job and native output stays unwritten. */
function unsharpLayout(pixelFormat:string,width:number,height:number,step:UnsharpStep){
 const storage=validate(pixelFormat,step);
 if(Math.trunc(height/(4*steps(step.luma).y))<1)throw new VideoUnsharpError('Unsharp heights below 4*(luma_msize_y/2) are not implemented: native writes no output');
 return pixelLayout(storage,width,height);
}
/** unsharp_slice_8 as one slice: the row FSM (sr) and the column FSM (sc) are 2*steps cascades of pairwise sums with edge replication. */
function unsharpPlane(src:Uint8Array,stride:number,data:Uint8Array,offset:number,width:number,height:number,param:UnsharpPlaneParam,signal:AbortSignal|undefined):void{
 const amount=param.amount;
 if(!amount){for(let y=0;y<height;y++){signal?.throwIfAborted();data.set(src.subarray(y*stride,y*stride+width),offset+y*width);}return;}
 const {x:stepsX,y:stepsY}=steps(param),scalebits=(stepsX+stepsY)*2,halfscale=2**(scalebits-1),divisor=2**scalebits;
 const sr=new Float64Array(2*stepsX),sc=Array.from({length:2*stepsY},()=>new Float64Array(width+2*stepsX));
 let row=0;
 for(let y=-stepsY;y<height+stepsY;y++){
  signal?.throwIfAborted();if(y<height)row=Math.max(y,0)*stride;
  // memset clears 2*steps_x-1 entries; the stale last entry only reaches column -steps_x, which is never output.
  sr.fill(0,0,2*stepsX-1);
  for(let x=-stepsX;x<width+stepsX;x++){
   let tmp1=src[row+(x<=0?0:x>=width?width-1:x)]!,tmp2:number;
   for(let z=0;z<stepsX*2;z+=2){tmp2=sr[z]!+tmp1;sr[z]=tmp1;tmp1=sr[z+1]!+tmp2;sr[z+1]=tmp2;}
   const column=x+stepsX;
   for(let z=0;z<stepsY*2;z+=2){const a=sc[z]!,b=sc[z+1]!;tmp2=a[column]!+tmp1;a[column]=tmp1;tmp1=b[column]!+tmp2;b[column]=tmp2;}
   if(x>=stepsX&&y>=stepsY){
    const outY=y-stepsY,outX=x-stepsX,p=src[outY*stride+outX]!,blur=Math.floor((tmp1+halfscale)/divisor);
    // (int64)(p-blur)*amount >> 16 is an arithmetic shift: floor division of an exact product below 2^53.
    const res=p+Math.floor((p-blur)*amount/65536);data[offset+outY*width+outX]=res<0?0:res>255?255:res;
   }
  }
 }
}
/** apply_unsharp: luma and alpha at full size, both chroma planes at the subsampled size, into owned tight planes. */
export function unsharpVideoFrame(frame:VideoFrameData,step:UnsharpStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=unsharpLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoUnsharpError('Unsharp frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoUnsharpError('Invalid unsharp plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoUnsharpError('Invalid unsharp plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoUnsharpError('Unsharp input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoUnsharpError('Invalid unsharp timestamp time base');
 const data=new Uint8Array(layout.bytes),params=[step.luma,step.chroma,step.chroma,step.alpha];
 for(const [index,plane]of layout.planes.entries())unsharpPlane(frame.planes[index]!,frame.linesizes[index]!,data,plane.offset,plane.width,plane.height,params[index]!,signal);
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const unsharpOperator=defineVideoOperator<UnsharpStep>({name:'unsharp',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv444p,unsharp','format=yuv420p,unsharp=3:3:-2:3:3:1.5,hflip','format=yuva420p,unsharp=lx=7:ly=3:la=0.75:cx=3:cy=5:ca=-1','format=yuv422p,unsharp=la=0'],
 parse:token=>singlePad(parseUnsharpOptions(token.options)),
 formats:()=>unsharpPixelFormats,validate:(pixelFormat,step)=>{validate(pixelFormat,step);},
 geometry:(step,[input])=>{unsharpLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>unsharpVideoFrame(frame,step,options)});
