import {pixelLayout} from '@edge-ffmpeg/avutil';import type {VideoFrameData} from '@edge-ffmpeg/avutil';
/** Materialize the initialized hflip plane extent from a larger dynamic frame. */
export function cropConfiguredFrame(frame:VideoFrameData,width:number,height:number,maxBytes:number):VideoFrameData{
 const target=pixelLayout(frame.pixelFormat,width,height);if(target.pixelFormat==='monob')throw new Error('Bit-packed configured crop requires format negotiation');if(target.bytes>maxBytes)throw new Error('Configured flip exceeds frame budget');if(frame.width<width||frame.height<height)throw new Error('Configured hflip extent exceeds dynamic input; Native padding behavior remains unverified');
 const planes=target.planes.map((plane,index)=>{const data=new Uint8Array(plane.bytes),source=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++)data.set(source.subarray(y*stride,y*stride+plane.rowBytes),y*plane.rowBytes);return data;});return {...frame,width,height,planes,linesizes:target.planes.map(plane=>plane.rowBytes)};
}
