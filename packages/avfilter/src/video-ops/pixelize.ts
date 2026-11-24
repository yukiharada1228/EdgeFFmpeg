// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_pixelize.c and libavutil/opt.c. See ../../NOTICE-PIXELIZE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type PixelizeStep={readonly name:'pixelize';readonly width:number;readonly height:number;readonly mode:0|1|2;readonly planes:number};
/** Eight-bit native pix_fmts intersected with the negotiation table, in table order; [log2_chroma_w, log2_chroma_h]. */
const chroma:Readonly<Record<string,readonly [number,number]>>={gray:[0,0],yuv420p:[1,1],yuv422p:[1,0],yuv444p:[0,0],yuva420p:[1,1],gbrp:[0,0]};
const formats=Object.freeze(negotiationOrder.filter(format=>Object.hasOwn(chroma,format)));
const modes:Readonly<Record<string,0|1|2>>={avg:0,min:1,max:2};
const integer=(value:string)=>/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(value)?Number(value):NaN;
/** AV_OPT_TYPE_INT width/height in [1,1024]: decimal or 0x integers only, not expressions. */
function blockSize(value:string,key:string):number{
 const n=integer(value);if(!Number.isSafeInteger(n))throw new VideoFilterParseError(`Only decimal or hexadecimal integer pixelize ${key} values are implemented`);
 if(n<1||n>1024)throw new VideoFilterParseError(`Pixelize ${key} ${n} is outside [1 - 1024]`);return n;
}
/** AV_OPT_TYPE_FLAGS without a unit: +/- folded integer terms; the declared range is not enforced natively. */
function planeFlags(value:string,current:number):number{
 if(value===''||value.length>255)throw new VideoFilterParseError('Only bounded nonempty pixelize plane flags are implemented');
 let position=0;
 for(;;){
  let command='';if(value[position]==='+'||value[position]==='-')command=value[position++]!;
  let end=position;while(end<value.length&&value[end]!=='+'&&value[end]!=='-')end++;
  const term=integer(value.slice(position,end));
  if(!Number.isSafeInteger(term)||term>0xffffffff)throw new VideoFilterParseError('Only decimal or hexadecimal integer pixelize plane flags up to 4294967295 are implemented');
  const intnum=current>>>0,d=command==='+'?Number(BigInt(intnum)|BigInt(term)):command==='-'?Number(BigInt(intnum)&~BigInt(term)):term;
  if(d>0xffffffff)throw new VideoFilterParseError('Pixelize planes are not a valid set of 32bit integer flags');
  current=d|0;position=end;if(position>=value.length)return current;
 }
}
export function parsePixelizeOptions(options:string|null):PixelizeStep{
 let width=16,height=16,mode:0|1|2=0,planes=15;
 for(const option of filterOptions(options,['width','height','mode','planes'])){
  switch(option.key){
   case 'width':case 'w':width=blockSize(option.value,'width');break;
   case 'height':case 'h':height=blockSize(option.value,'height');break;
   case 'mode':case 'm':{const n=Object.hasOwn(modes,option.value)?modes[option.value]!:integer(option.value);if(n!==0&&n!==1&&n!==2)throw new VideoFilterParseError('Only pixelize modes avg, min, max, 0, 1 and 2 are implemented');mode=n;break;}
   case 'planes':case 'p':planes=planeFlags(option.value,planes);break;
   case 'enable':throw new VideoFilterParseError('Pixelize timeline expressions are not implemented');
   default:throw new VideoFilterParseError('Unsupported pixelize option');
  }
 }
 return Object.freeze({name:'pixelize',width,height,mode,planes});
}
const checkStep=(step:PixelizeStep)=>{if(!Number.isInteger(step.width)||step.width<1||step.width>1024||!Number.isInteger(step.height)||step.height<1||step.height>1024||![0,1,2].includes(step.mode)||!Number.isInteger(step.planes))throw new Error('Invalid pixelize settings');};
/** filter_frame and pixelize_slice: per-plane block grid with partial edge blocks, unselected planes copied. */
export function pixelizeVideoFrame(frame:VideoFrameData,step:PixelizeStep,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal}):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),shift=chroma[layout.pixelFormat];if(!shift)throw new Error('Pixelize pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Pixelize frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid pixelize plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid pixelize plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new Error('Pixelize input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid pixelize timestamp time base');
 // Chroma blocks are the luma size shifted down (at least 1); luma and alpha blocks are that shifted back up.
 const [log2w,log2h]=shift,chromaW=Math.max(1,step.width>>log2w),chromaH=Math.max(1,step.height>>log2h),lumaW=chromaW<<log2w,lumaH=chromaH<<log2h;
 const data=new Uint8Array(layout.bytes),{mode,planes}=step;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,target=data.subarray(plane.offset,plane.offset+plane.bytes),pw=plane.width,ph=plane.height;
  if(!(planes>>index&1)){for(let y=0;y<ph;y++){signal?.throwIfAborted();target.set(input.subarray(y*stride,y*stride+pw),y*pw);}continue;}
  const bw=index===1||index===2?chromaW:lumaW,bh=index===1||index===2?chromaH:lumaH;
  for(let by=0;by<ph;by+=bh){
   signal?.throwIfAborted();const h=Math.min(bh,ph-by);
   for(let bx=0;bx<pw;bx+=bw){
    const w=Math.min(bw,pw-bx);let fill=input[by*stride+bx]!,sum=0;
    for(let y=0;y<h;y++){const row=(by+y)*stride+bx;for(let x=0;x<w;x++){const v=input[row+x]!;if(mode===0)sum+=v;else if(mode===1?v<fill:v>fill)fill=v;}}
    if(mode===0)fill=Math.floor(sum/(w*h));
    for(let y=0;y<h;y++){const row=(by+y)*pw+bx;target.fill(fill,row,row+w);}
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const pixelizeOperator=defineVideoOperator<PixelizeStep>({name:'pixelize',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['pixelize','pixelize=3:2:max','pixelize=w=4:h=3:mode=min:planes=0x1,hflip'],
 parse:token=>singlePad(parsePixelizeOptions(token.options)),
 formats:()=>formats,
 frame:(frame,step,options)=>pixelizeVideoFrame(frame,step,options)});
