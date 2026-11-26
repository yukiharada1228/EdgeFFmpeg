// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromakey.c and the AV_OPT_TYPE_FLOAT/BOOL paths of libavutil/opt.c. See ../NOTICE-CHROMAKEY.
import {ColorParseError,parseColor,pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {VideoFilterParseError} from './video-ops/descriptor.js';
import {filterBoolean} from './video-ops/options.js';
export class VideoChromakeyError extends Error {}
export type ChromakeyName='chromakey'|'chromahold';
/** color is the parsed RGBA (alpha unused); similarity and blend are the stored floats; threads is the generic filter option,
 * 0 (the graph's thread count) or 1. */
export interface ChromakeySettings<N extends ChromakeyName=ChromakeyName> {readonly name:N;readonly color:readonly [number,number,number,number];readonly similarity:number;readonly blend:number;readonly yuv:boolean;readonly threads:0|1}
const decimal=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** AV_OPT_TYPE_FLOAT: the double is range-checked, then stored as a float. Only decimal literals are implemented, not expressions. */
function floatOption(name:ChromakeyName,key:string,value:string,min:number):number{
 if(!decimal.test(value))throw new VideoFilterParseError(`Only decimal ${name} ${key} values are implemented`);
 const n=Number(value);if(!(n>=min&&n<=1))throw new VideoFilterParseError(`Value ${n} for parameter '${key}' out of range [${min===0?0:'1e-05'} - 1]`);
 return Math.fround(n)+0;
}
/** Options in native order color:similarity:blend:yuv, plus the generic threads=1; the last repeated key wins. */
export function parseChromakeyOptions<N extends ChromakeyName>(name:N,options:string|null):ChromakeySettings<N>{
 let color:readonly [number,number,number,number]=parseColor('black'),similarity=Math.fround(0.01),blend=0,yuv=false,threads:0|1=0;
 for(const option of filterOptions(options,['color','similarity','blend','yuv'])){
  switch(option.key){
   case 'color':try{color=parseColor(option.value);}catch(error){if(error instanceof ColorParseError)throw new VideoFilterParseError(error.code==='invalid'?error.message:`${error.message} by ${name}`);throw error;}break;
   case 'similarity':similarity=floatOption(name,'similarity',option.value,0.00001);break;
   case 'blend':blend=floatOption(name,'blend',option.value,0);break;
   case 'yuv':try{yuv=filterBoolean(option.value);}catch{throw new VideoFilterParseError(`Invalid ${name} yuv boolean '${option.value}'`);}break;
   case 'threads':if(!/^0*1$/.test(option.value))throw new VideoFilterParseError(`Only ${name} threads=1 is implemented`);threads=1;break;
   case 'enable':throw new VideoFilterParseError(`${name} timeline expressions are not implemented`);
   default:throw new VideoFilterParseError(`Unsupported ${name} option`);
  }
 }
 return Object.freeze({name,color,similarity,blend,yuv,threads});
}
/** config_output at depth 8 (factor 1): the color as U/V, or the RGB_TO_U/RGB_TO_V integer macros with lrint(x*1024) coefficients. */
export function chromakeyUV(settings:Pick<ChromakeySettings,'color'|'yuv'>):readonly [number,number]{
 const [r,g,b]=settings.color;if(settings.yuv)return [g,b];
 return [((-173*r-339*g+512*b+511)>>10)+128,((512*r-429*g-83*b+511)>>10)+128];
}
interface Planes {readonly layout:ReturnType<typeof pixelLayout>;readonly data:Uint8Array}
const checkSettings=(step:ChromakeySettings)=>{
 const {color,similarity,blend}=step;
 if(color.length!==4||!color.every(c=>Number.isInteger(c)&&c>=0&&c<=255)||!(similarity>=Math.fround(0.00001)&&similarity<=1)||Math.fround(similarity)!==similarity||!(blend>=0&&blend<=1)||Math.fround(blend)!==blend||typeof step.yuv!=='boolean'||step.threads!==0&&step.threads!==1)throw new VideoChromakeyError(`Invalid ${step.name} settings`);
};
/** Checks the frame and copies every plane into owned tight storage, which the in-place native kernels then modify. */
function owned(frame:VideoFrameData,step:ChromakeySettings,formats:readonly string[],maxFrameBytes:number,signal?:AbortSignal):Planes{
 const label=step.name==='chromakey'?'Chromakey':'Chromahold';signal?.throwIfAborted();checkSettings(step);
 if(!formats.includes(frame.pixelFormat))throw new VideoChromakeyError(`${label} pixel format is not supported`);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoChromakeyError(`${label} frame exceeds allocation limit`);
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoChromakeyError(`Invalid ${step.name} plane count`);
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoChromakeyError(`Invalid ${step.name} plane stride or storage`);
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoChromakeyError(`${label} input plane storage exceeds allocation limit`);
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoChromakeyError(`Invalid ${step.name} timestamp time base`);
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){const input=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}}
 return {layout,data};
}
const result=(frame:VideoFrameData,{layout,data}:Planes):VideoFrameData=>({width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}});
/** [log2_chroma_w, log2_chroma_h] of the eight-bit formats with frame storage here. */
const subsampling:Readonly<Record<string,readonly [number,number]>>={yuv420p:[1,1],yuv422p:[1,0],yuv444p:[0,0],yuva420p:[1,1]};
export const chromakeyStorageFormats:readonly string[]=Object.freeze(['yuva420p']);
export const chromaholdStorageFormats:readonly string[]=Object.freeze(['yuv420p','yuv422p','yuv444p','yuva420p']);
const SCALE=255*255*2;
/** Native runs min(height, threads) slices and restarts the u/v windows at the key in each, so with the graph's thread count the
 * alpha of a frame taller than one row depends on the host CPU count. Only one slice is implemented: threads=1, or one row. */
export function chromakeyGeometry(step:ChromakeySettings,width:number,height:number):{readonly width:number;readonly height:number}{
 if(step.name==='chromakey'&&step.threads!==1&&height>1)throw new VideoChromakeyError('Chromakey frames taller than one row need threads=1: native alpha depends on the filter thread count');
 return {width,height};
}
/**
 * do_chromakey_slice as one slice (one filter thread): the 3x3 luma-coordinate neighbourhood samples chroma at (x>>hsub, y>>vsub).
 * The u/v windows start as the key and persist across pixels, so a neighbour outside the frame keeps the value its window slot
 * last held. The alpha is the mean of nine correctly rounded double square roots, then the threshold or the clipped blend
 * ramp scaled by 255 and truncated.
 */
export function chromakeyVideoFrame(frame:VideoFrameData,step:ChromakeySettings,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal}):VideoFrameData{
 if(step.name!=='chromakey')throw new VideoChromakeyError('Invalid chromakey settings');checkSettings(step);chromakeyGeometry(step,frame.width,frame.height);
 const planes=owned(frame,step,chromakeyStorageFormats,options.maxFrameBytes,options.signal),{layout,data}=planes,signal=options.signal;
 const [hsub,vsub]=subsampling[layout.pixelFormat]!,{width:w,height:h}=frame,[ku,kv]=chromakeyUV(step),similarity=step.similarity,blend=step.blend,ramp=blend>0.0001;
 const U=layout.planes[1]!,V=layout.planes[2]!,A=layout.planes[3]!,u=new Int32Array(9).fill(ku),v=new Int32Array(9).fill(kv);
 for(let y=0;y<h;y++){
  signal?.throwIfAborted();
  for(let x=0;x<w;x++){
   for(let yo=0;yo<3;yo++){const py=y+yo-1;if(py<0||py>=h)continue;const ur=U.offset+(py>>vsub)*U.rowBytes,vr=V.offset+(py>>vsub)*V.rowBytes;for(let xo=0;xo<3;xo++){const px=x+xo-1;if(px<0||px>=w)continue;u[yo*3+xo]=data[ur+(px>>hsub)]!;v[yo*3+xo]=data[vr+(px>>hsub)]!;}}
   let diff=0;for(let i=0;i<9;i++){const du=u[i]!-ku,dv=v[i]!-kv;diff+=Math.sqrt((du*du+dv*dv)/SCALE);}
   diff/=9;
   const t=ramp?(diff-similarity)/blend:0;
   data[A.offset+y*A.rowBytes+x]=ramp?Math.trunc((t<0?0:t>1?1:t)*255):diff>similarity?255:0;
  }
 }
 return result(frame,planes);
}
/** do_chromahold_slice: each of the (w>>hsub) x (h>>vsub) chroma samples moves toward 128; a trailing odd column or row is kept. */
export function chromaholdVideoFrame(frame:VideoFrameData,step:ChromakeySettings,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal}):VideoFrameData{
 if(step.name!=='chromahold')throw new VideoChromakeyError('Invalid chromahold settings');
 const planes=owned(frame,step,chromaholdStorageFormats,options.maxFrameBytes,options.signal),{layout,data}=planes,signal=options.signal;
 const [hsub,vsub]=subsampling[layout.pixelFormat]!,[ku,kv]=chromakeyUV(step),similarity=step.similarity,blend=step.blend,ramp=blend>0.0001;
 const U=layout.planes[1]!,V=layout.planes[2]!,cw=frame.width>>hsub,ch=frame.height>>vsub;
 for(let y=0;y<ch;y++){
  signal?.throwIfAborted();
  for(let x=0;x<cw;x++){
   const ui=U.offset+y*U.rowBytes+x,vi=V.offset+y*V.rowBytes+x,uu=data[ui]!,vv=data[vi]!,du=uu-ku,dv=vv-kv,diff=Math.sqrt((du*du+dv*dv)/SCALE);
   if(ramp){const t=(diff-similarity)/blend,f=1-(t<0?0:t>1?1:t);data[ui]=Math.trunc(128+(uu-128)*f);data[vi]=Math.trunc(128+(vv-128)*f);}
   else if(diff>similarity){data[ui]=128;data[vi]=128;}
  }
 }
 return result(frame,planes);
}
