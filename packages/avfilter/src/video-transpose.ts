import type {Rational} from '@edge-ffmpeg/avutil';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg vf_transpose.c; Stefano Sabatini (2010), Vitor Sessak (2008).
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export class VideoTransposeError extends Error {}
export interface VideoTransposeOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** Materialize a transposition into owned tight planes with positive strides. */
export function transposeVideoFrame(frame:VideoFrameData,direction:0|1|2|3,options:VideoTransposeOptions):VideoFrameData {
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!Number.isInteger(direction)||direction<0||direction>3)throw new VideoTransposeError('Invalid video transpose direction');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(layout.pixelFormat==='pal8'||layout.pixelFormat==='monob')throw new VideoTransposeError('Paletted or bit-packed transpose requires format negotiation');
 if(layout.pixelFormat==='yuv422p')throw new VideoTransposeError('Transpose requires equal horizontal and vertical chroma subsampling');
 const output=pixelLayout(frame.pixelFormat,frame.height,frame.width);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoTransposeError('Transpose frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoTransposeError('Invalid transpose plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoTransposeError('Invalid transpose plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoTransposeError('Transpose input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoTransposeError('Invalid transpose timestamp time base');
 const data=new Uint8Array(output.bytes);
 for(const [index,plane]of output.planes.entries()){
  const input=frame.planes[index]!,sourcePlane=layout.planes[index]!,stride=frame.linesizes[index]!,step=plane.rowBytes/plane.width;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();
   for(let x=0;x<plane.width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const sourceX=(direction&2)?sourcePlane.width-1-y:y,sourceY=(direction&1)?sourcePlane.height-1-x:x;
    const source=sourceY*stride+sourceX*step,target=plane.offset+y*plane.rowBytes+x*step;
    for(let component=0;component<step;component++)data[target+component]=input[source+component]!;
   }
  }
 }
 const metadata={...frame.metadata},sar=metadata.sampleAspectRatio as Rational|undefined;if(sar?.num)metadata.sampleAspectRatio=Object.freeze({num:sar.den,den:sar.num});
 return {width:frame.height,height:frame.width,pixelFormat:layout.pixelFormat,planes:output.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:output.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata};
}
