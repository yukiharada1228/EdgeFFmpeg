// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_yaepblur.c and libavutil/opt.c. See ../../NOTICE-YAEPBLUR.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterIntegerOption} from '../activation/integer-option.js';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoYaepblurError extends Error {}
export type YaepblurStep={readonly name:'yaepblur';readonly radius:number;readonly planes:number;readonly sigma:number};
/** The pinned vf_yaepblur.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const yaepblurPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(yaepblurPixelFormats.filter(executableFormat));
const INT_MAX=2147483647,shorthand=['radius','planes','sigma'] as const,generic=['threads','thread_type','extra_hw_frames'];
/** AVOption table: radius/r and sigma/s are INT in [0|1, INT_MAX], planes/p INT in [0, 0xF]; aliases share one field and the last write wins.
 * Positional values follow the declared order with aliases skipped (radius, planes, sigma). */
const fields:Readonly<Record<string,{readonly field:'radius'|'planes'|'sigma';readonly min:number;readonly max:number;readonly defaultValue:number}>>={
 radius:{field:'radius',min:0,max:INT_MAX,defaultValue:3},r:{field:'radius',min:0,max:INT_MAX,defaultValue:3},
 planes:{field:'planes',min:0,max:15,defaultValue:1},p:{field:'planes',min:0,max:15,defaultValue:1},
 sigma:{field:'sigma',min:1,max:INT_MAX,defaultValue:128},s:{field:'sigma',min:1,max:INT_MAX,defaultValue:128}};
export function parseYaepblurOptions(options:string|null):YaepblurStep{
 const values={radius:3,planes:1,sigma:128};
 for(const option of filterOptions(options,shorthand)){
  const spec=Object.hasOwn(fields,option.key)?fields[option.key]:undefined;
  // Generic AVFilterContext options exist natively but are not implemented here; anything else is unknown to native too.
  if(!spec)throw new VideoFilterParseError(option.key==='enable'?'Yaepblur timeline expressions are not implemented':generic.includes(option.key)?`Yaepblur option ${option.key} is not implemented`:`Error applying option '${option.key}' to filter 'yaepblur': Option not found`);
  try{values[spec.field]=filterIntegerOption(option.value,spec);}catch(error){throw new VideoFilterParseError(`Error applying option '${option.key}' to filter 'yaepblur': ${error instanceof Error&&error.message==='Integer filter option outside range'?'Numerical result out of range':'Invalid argument'}`);}
 }
 return Object.freeze({name:'yaepblur',...values});
}
const checkStep=(step:YaepblurStep)=>{if(step?.name!=='yaepblur'||!Number.isInteger(step.radius)||step.radius<0||step.radius>INT_MAX||!Number.isInteger(step.planes)||step.planes<0||step.planes>15||!Number.isInteger(step.sigma)||step.sigma<1||step.sigma>INT_MAX)throw new VideoYaepblurError('Invalid yaepblur settings');};
/** config_input: the radius is clipped to AV_CEIL_RSHIFT(FFMIN(w, h), 1) of the luma size for every plane.
 * Planes whose window sum could reach 2^32 (255*w*h) are refused: native's uint64 sum*sum could wrap there. Below it every table
 * value (at most 65025*w*h) is an exact double. */
function yaepblurLayout(pixelFormat:string,width:number,height:number,step:YaepblurStep){
 checkStep(step);const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoYaepblurError('Yaepblur pixel format is not supported');
 if(255*width*height>=2**32)throw new VideoYaepblurError('Yaepblur planes of 2^32/255 samples or more are not implemented');
 return {layout,radius:Math.min(step.radius,(Math.min(width,height)+1)>>1)};
}
/** var = (square_sum - sum*sum/count)/count in uint64: exact doubles while sum*sum is a safe integer, else exact BigInt. sum stays
 * below 2^32 (yaepblurLayout), so native's sum*sum never wraps, and Cauchy-Schwarz keeps the difference non-negative. */
const variance=(sum:number,square:number,count:number)=>{
 if(sum<=94906265)return Math.floor((square-Math.floor(sum*sum/count))/count);
 const n=BigInt(count),s=BigInt(sum);return Number((BigInt(square)-s*s/n)/n);
};
/** filter_frame per selected plane: the summed-area tables of pre_calculate_row/pre_calculate_col, read through filter_slice's clipped window.
 * Each output row needs only the difference of two table rows, sat[higher_y] - sat[lower_y], which is the horizontal prefix of the column
 * sums over [lower_y, higher_y); it is kept as running column sums so the scratch is O(width) and every sum equals native's exactly. */
export function yaepblurVideoFrame(frame:VideoFrameData,step:YaepblurStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {layout,radius}=yaepblurLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoYaepblurError('Yaepblur frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoYaepblurError('Invalid yaepblur plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoYaepblurError('Invalid yaepblur plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoYaepblurError('Yaepblur input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoYaepblurError('Invalid yaepblur timestamp time base');
 const data=new Uint8Array(layout.bytes),sigma=step.sigma;
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,{width,height}=plane;
  if(!radius||!(step.planes&(1<<index))){for(let y=0;y<height;y++){signal?.throwIfAborted();data.set(src.subarray(y*stride,y*stride+width),plane.offset+y*width);}continue;}
  const column=new Float64Array(width),columnSquare=new Float64Array(width),sat=new Float64Array(width+1),squareSat=new Float64Array(width+1);let top=0,bottom=0;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();
   const lowerY=y-radius<0?0:y-radius,higherY=y+radius+1>height?height:y+radius+1,distY=higherY-lowerY,target=plane.offset+y*width;
   for(;bottom<higherY;bottom++){const row=bottom*stride;for(let x=0;x<width;x++){const v=src[row+x]!;column[x]!+=v;columnSquare[x]!+=v*v;}}
   for(;top<lowerY;top++){const row=top*stride;for(let x=0;x<width;x++){const v=src[row+x]!;column[x]!-=v;columnSquare[x]!-=v*v;}}
   for(let x=0;x<width;x++){sat[x+1]=sat[x]!+column[x]!;squareSat[x+1]=squareSat[x]!+columnSquare[x]!;}
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    const lowerX=x-radius<0?0:x-radius,higherX=x+radius+1>width?width:x+radius+1,count=distY*(higherX-lowerX);
    const sum=sat[higherX]!-sat[lowerX]!,square=squareSat[higherX]!-squareSat[lowerX]!,mean=Math.floor(sum/count),v=variance(sum,square,count);
    data[target+x]=Math.floor((sigma*mean+v*src[y*stride+x]!)/(sigma+v));
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused; actor and timed run the stateless frame function. */
export const yaepblurOperator=defineVideoOperator<YaepblurStep>({name:'yaepblur',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['yaepblur','yaepblur=r=1:s=2,hflip','yaepblur=2:1:30'],
 parse:token=>singlePad(parseYaepblurOptions(token.options)),
 formats:()=>yaepblurPixelFormats,
 geometry:(step,[input])=>{yaepblurLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>yaepblurVideoFrame(frame,step,options)});
