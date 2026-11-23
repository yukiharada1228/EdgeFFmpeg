import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export class VideoFlipError extends Error {}
export interface VideoFlipOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** Materialize an axis reflection into owned tight planes with positive strides. */
export function flipVideoFrame(frame:VideoFrameData,direction:'horizontal'|'vertical',options:VideoFlipOptions):VideoFrameData {
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(direction!=='horizontal'&&direction!=='vertical')throw new VideoFlipError('Invalid video flip direction');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(layout.pixelFormat==='monob'&&direction==='horizontal')throw new VideoFlipError('Bit-packed horizontal flip requires format negotiation');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoFlipError('Flip frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoFlipError('Invalid flip plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoFlipError('Invalid flip plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoFlipError('Flip input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoFlipError('Invalid flip timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,step=plane.rowBytes/plane.width;
  if(layout.pixelFormat==='pal8'&&index===1){data.set(input.subarray(0,1024),plane.offset);continue;}
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const sourceY=direction==='vertical'?plane.height-1-y:y,sourceRow=sourceY*stride,targetRow=plane.offset+y*plane.rowBytes;
   if(direction==='vertical'){data.set(input.subarray(sourceRow,sourceRow+plane.rowBytes),targetRow);continue;}
   for(let x=0;x<plane.width;x++){
    if((x&4095)===0)signal?.throwIfAborted();const source=sourceRow+(plane.width-1-x)*step,target=targetRow+x*step;
    for(let component=0;component<step;component++)data[target+component]=input[source+component]!;
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
