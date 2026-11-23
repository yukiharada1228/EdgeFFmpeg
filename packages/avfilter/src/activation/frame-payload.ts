import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import type {FrameEvent as TimedVideoFrameEvent} from '../setpts/stream.js';
export interface ActorGeometry {format:string;width:number;height:number}
export function validateActorFrame(event:TimedVideoFrameEvent,geometry:ActorGeometry,timeBase:Rational,maxBytes:number):void{
 const frame=event.frame,layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),expected=pixelLayout(geometry.format,geometry.width,geometry.height);
 if(event.kind!=='frame'||layout.pixelFormat!==expected.pixelFormat||frame.width!==geometry.width||frame.height!==geometry.height||frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Actor source frame differs from declaration');
 let resident=0n;for(const [index,plane]of layout.planes.entries()){
  const data=frame.planes[index]!,stride=frame.linesizes[index]!;
  if(!(data instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride<plane.rowBytes||BigInt(data.byteLength)<BigInt(stride)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid actor source plane storage');
  resident+=BigInt(data.byteLength);
 }
 if(resident>BigInt(maxBytes))throw new Error('Actor source payload exceeds byte budget');
 const pts=frame.pts;if(pts&&(typeof pts.value!=='bigint'||pts.value<-(1n<<63n)||pts.value>=(1n<<63n)||pts.timeBase.num!==timeBase.num||pts.timeBase.den!==timeBase.den))throw new Error('Actor source timestamp differs from declared clock');
 if(typeof event.duration!=='bigint'||event.duration<-(1n<<63n)||event.duration>=(1n<<63n))throw new Error('Invalid actor frame duration');
}
/** Visible bytes in wire plane order, excluding positive-stride padding. */
export function actorFrameBytes(event:TimedVideoFrameEvent):number[]{
 const frame=event.frame,layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),result:number[]=[];
 for(const [index,plane]of layout.planes.entries())for(let row=0;row<plane.height;row++){
  const start=row*frame.linesizes[index]!;for(let column=0;column<plane.rowBytes;column++)result.push(frame.planes[index]![start+column]!);
 }
 return result;
}
