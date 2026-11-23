import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {convertVideoFrame} from '@edge-ffmpeg/swscale';
import type {BmpOptions} from '@edge-ffmpeg/avcodec';
export function bmpEncoderPixelFormat(format:string):string {
 return ['bgr0','rgb0','0bgr','0rgb'].includes(format)?'bgr24':['abgr','argb','rgba'].includes(format)?'bgra':format;
}
/** Normalize unused bytes before the existing RGB byte-permutation converter. */
export function prepareBmpEncodingFrame(frame:VideoFrameData,target:string,options:BmpOptions):VideoFrameData {
 if(frame.pixelFormat===target)return frame;
 const offsets:Record<string,readonly number[]>={bgr0:[0,1,2],rgb0:[2,1,0],'0bgr':[1,2,3],'0rgb':[3,2,1]};
 let source=frame;
 if(Object.hasOwn(offsets,frame.pixelFormat)){
  const bytes=frame.width*frame.height*4;
  if(bytes>options.maxFrameBytes)throw new Error('BMP conversion exceeds frame budget');
  const pixels=new Uint8Array(bytes),order=offsets[frame.pixelFormat]!;
  for(let y=0;y<frame.height;y++){
   options.signal?.throwIfAborted();
   for(let x=0;x<frame.width;x++){const input=y*frame.linesizes[0]!+x*4,output=(y*frame.width+x)*4;for(let c=0;c<3;c++)pixels[output+c]=frame.planes[0]![input+order[c]!]!;pixels[output+3]=255;}
  }
  source={...frame,pixelFormat:'bgra',planes:[pixels],linesizes:[frame.width*4]};
 }
 return convertVideoFrame(source,target,options);
}
