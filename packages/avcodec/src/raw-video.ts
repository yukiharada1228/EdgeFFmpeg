import {pixelLayout,videoFrameRate,rescale} from '@edge-ffmpeg/avutil';
import type {MediaPacket,VideoFrameData,Rational} from '@edge-ffmpeg/avutil';
export class RawVideoCodecError extends Error {}
export interface RawVideoCodecOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
export interface RawVideoFrameFormat {readonly width:number;readonly height:number;readonly pixelFormat:string}
function budget(bytes:number,options:RawVideoCodecOptions){options.signal?.throwIfAborted();if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1||bytes>options.maxFrameBytes)throw new RawVideoCodecError('Raw video frame exceeds allocation limit');}
/** One complete tight raw packet becomes independently owned, disjoint plane views. */
export function decodeRawVideo(packet:MediaPacket,format:RawVideoFrameFormat,options:RawVideoCodecOptions):VideoFrameData{
  const layout=pixelLayout(format.pixelFormat,format.width,format.height);budget(layout.bytes,options);
  if(!(packet.data instanceof Uint8Array)||packet.data.length!==layout.bytes||packet.timeBase.num<=0n||packet.timeBase.den<=0n)throw new RawVideoCodecError('Invalid raw video packet size or time base');
  const data=new Uint8Array(layout.bytes);for(let offset=0;offset<data.length;offset+=65536){options.signal?.throwIfAborted();data.set(packet.data.subarray(offset,offset+65536),offset);}
  return {width:layout.width,height:layout.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:packet.pts===null?null:{value:packet.pts,timeBase:{...packet.timeBase}},metadata:{}};
}
/** Copy visible rows into an owned tight packet; positive padded strides are supported. */
export function encodeRawVideo(frame:VideoFrameData,frameRate:Rational,options:RawVideoCodecOptions):MediaPacket{
  const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),rate=videoFrameRate(frameRate);budget(layout.bytes,options);
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new RawVideoCodecError('Invalid raw video plane count');
  let resident=0n;
  for(const [index,plane]of layout.planes.entries()){
    const data=frame.planes[index],stride=frame.linesizes[index];
    if(!(data instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||data.length<stride!*(plane.height-1)+plane.rowBytes)throw new RawVideoCodecError('Invalid raw video plane stride or storage');
    resident+=BigInt(data.length);
  }
  if(resident>BigInt(options.maxFrameBytes))throw new RawVideoCodecError('Raw video input planes exceed aggregate frame limit');
  if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new RawVideoCodecError('Invalid raw video timestamp time base');
  const data=new Uint8Array(layout.bytes);
  for(const [index,plane]of layout.planes.entries())for(let row=0;row<plane.height;row++){
    options.signal?.throwIfAborted();const offset=row*frame.linesizes[index]!;data.set(frame.planes[index]!.subarray(offset,offset+plane.rowBytes),plane.offset+row*plane.rowBytes);
  }
  const timeBase={num:rate.den,den:rate.num},pts=frame.pts===null?null:rescale(frame.pts.value,frame.pts.timeBase,timeBase);
  return {streamIndex:0,data,pts,dts:pts,duration:1n,timeBase,flags:1};
}
