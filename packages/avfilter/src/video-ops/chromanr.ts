// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromanr.c and libavutil/opt.c. See ../../NOTICE-CHROMANR.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
export type ChromanrStep={readonly name:'chromanr';readonly thres:number;readonly sizew:number;readonly sizeh:number;readonly stepw:number;readonly steph:number;readonly threy:number;readonly threu:number;readonly threv:number;readonly distance:0|1};
/** The pinned pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const chromanrPixelFormats:readonly string[]=Object.freeze('yuv420p yuv422p yuv440p yuv411p yuv444p yuva420p yuva422p yuva444p yuvj444p yuvj440p yuvj422p yuvj420p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv444p12le yuv422p12le yuv440p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
/** The eight-bit members with frame storage here; [log2_chroma_w, log2_chroma_h]. */
const chroma:Readonly<Record<string,readonly [number,number]>>={yuv420p:[1,1],yuv422p:[1,0],yuv444p:[0,0],yuva420p:[1,1]};
const integers={sizew:[1,100],sizeh:[1,100],stepw:[1,50],steph:[1,50]} as const;
/** AV_OPT_TYPE_INT: decimal or 0x integers only, not expressions; out-of-range values fail as natively. */
function integerValue(value:string,key:keyof typeof integers):number{
 const n=/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(value)?Number(value):NaN,[min,max]=integers[key];
 if(!Number.isSafeInteger(n))throw new VideoFilterParseError(`Only decimal or hexadecimal integer chromanr ${key} values are implemented`);
 if(n<min||n>max)throw new VideoFilterParseError(`Chromanr ${key} ${n} is outside [${min} - ${max}]`);return n;
}
/** AV_OPT_TYPE_FLOAT: the double is range-checked against [1,200], then stored as float. Expressions and constants are not implemented. */
function floatValue(value:string,key:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))throw new VideoFilterParseError(`Only decimal chromanr ${key} values are implemented`);
 const n=Number(value);if(!(n>=1&&n<=200))throw new VideoFilterParseError(`Chromanr ${key} ${n} is outside [1 - 200]`);return Math.fround(n);
}
export function parseChromanrOptions(options:string|null):ChromanrStep{
 const values={thres:30,sizew:5,sizeh:5,stepw:1,steph:1,threy:200,threu:200,threv:200,distance:0 as 0|1};
 for(const option of filterOptions(options,['thres','sizew','sizeh','stepw','steph','threy','threu','threv','distance'])){
  switch(option.key){
   case 'thres':case 'threy':case 'threu':case 'threv':values[option.key]=floatValue(option.value,option.key);break;
   case 'sizew':case 'sizeh':case 'stepw':case 'steph':values[option.key]=integerValue(option.value,option.key);break;
   case 'distance':{const n=option.value==='manhattan'||option.value==='0'?0:option.value==='euclidean'||option.value==='1'?1:-1;if(n===-1)throw new VideoFilterParseError('Only chromanr distances manhattan, euclidean, 0 and 1 are implemented');values.distance=n;break;}
   case 'enable':throw new VideoFilterParseError('Chromanr timeline expressions are not implemented');
   default:throw new VideoFilterParseError('Unsupported chromanr option');
  }
 }
 return Object.freeze({name:'chromanr',...values});
}
const checkStep=(step:ChromanrStep)=>{
 const float=(n:number)=>typeof n==='number'&&n>=1&&n<=200&&Math.fround(n)===n,int=(n:number,max:number)=>Number.isInteger(n)&&n>=1&&n<=max;
 if(!float(step.thres)||!float(step.threy)||!float(step.threu)||!float(step.threv)||!int(step.sizew,100)||!int(step.sizeh,100)||!int(step.stepw,50)||!int(step.steph,50)||(step.distance!==0&&step.distance!==1))throw new Error('Invalid chromanr settings');
};
/** filter_frame and the eight-bit slice functions: luma and alpha copied, each chroma sample replaced by the rounded mean of itself and
 * every window sample (center included) whose distance is below the thresholds. Owned tight planes. */
export function chromanrVideoFrame(frame:VideoFrameData,step:ChromanrStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),shift=chroma[layout.pixelFormat];if(!shift)throw new Error('Chromanr pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Chromanr frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid chromanr plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid chromanr plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new Error('Chromanr input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid chromanr timestamp time base');
 // Depth 8: filter_frame's float thresholds times 1 truncate to int; any of threy/threu/threv below 200 selects the _e slices.
 const thres=Math.trunc(step.thres),ty=Math.trunc(step.threy),tu=Math.trunc(step.threu),tv=Math.trunc(step.threv),extra=step.threy<200||step.threu<200||step.threv<200;
 const euclidean=step.distance===1,{sizew,sizeh,stepw,steph}=step,cw=1<<shift[0],ch=1<<shift[1],data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries())if(index===0||index===3){const input=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}}
 const Y=frame.planes[0]!,U=frame.planes[1]!,V=frame.planes[2]!,ys=frame.linesizes[0]!,us=frame.linesizes[1]!,vs=frame.linesizes[2]!,up=layout.planes[1]!,vp=layout.planes[2]!,w=up.width,h=up.height;
 for(let y=0;y<h;y++){
  signal?.throwIfAborted();const yr=y*ch*ys,yystart=Math.max(0,y-sizeh),yystop=Math.min(h-1,y+sizeh);
  for(let x=0;x<w;x++){
   const xxstart=Math.max(0,x-sizew),xxstop=Math.min(w-1,x+sizew),cy=Y[yr+x*cw]!,cu=U[y*us+x]!,cv=V[y*vs+x]!;let su=cu,sv=cv,cn=1;
   for(let yy=yystart;yy<=yystop;yy+=steph){
    const ry=yy*ch*ys,ru=yy*us,rv=yy*vs;
    for(let xx=xxstart;xx<=xxstop;xx+=stepw){
     const u=U[ru+xx]!,v=V[rv+xx]!,dy=Math.abs(cy-Y[ry+xx*cw]!),du=Math.abs(cu-u),dv=Math.abs(cv-v);
     // sqrtf of an exact integer sum (below 2^24) is correctly rounded, so Math.fround(Math.sqrt) reproduces it.
     const d=euclidean?Math.fround(Math.sqrt(dy*dy+du*du+dv*dv)):dy+du+dv;
     if(d<thres&&(!extra||du<tu&&dv<tv&&dy<ty)){su+=u;sv+=v;cn++;}
    }
   }
   data[up.offset+y*up.rowBytes+x]=Math.floor((su+(cn>>1))/cn);data[vp.offset+y*vp.rowBytes+x]=Math.floor((sv+(cn>>1))/cn);
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const chromanrOperator=defineVideoOperator<ChromanrStep>({name:'chromanr',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv420p,chromanr','format=yuv444p,chromanr=thres=12:sizew=2:sizeh=3:distance=euclidean,hflip','format=yuva420p,chromanr=200:1:1:2:2:threu=50.5'],
 parse:token=>singlePad(parseChromanrOptions(token.options)),
 formats:()=>chromanrPixelFormats,
 frame:(frame,step,options)=>chromanrVideoFrame(frame,step,options)});
