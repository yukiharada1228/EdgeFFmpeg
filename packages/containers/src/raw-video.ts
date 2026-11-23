import {muxerSoftware} from './reference-metadata.js';
import type {ReferenceMetadataProfile} from './reference-metadata.js';
import {pixelLayout,videoFrameRate} from '@edge-ffmpeg/avutil';
import type {PixelLayout,Rational,MediaPacket} from '@edge-ffmpeg/avutil';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import {frameCrcChecksum} from './framecrc.js';
export class RawVideoError extends Error {}
export interface RawVideoParameters {readonly width:number;readonly height:number;readonly pixelFormat:string;readonly frameRate:Rational}
export interface RawVideoOptions extends RawVideoParameters {readonly maxReadBytes:number;readonly maxFrameBytes:number;readonly signal?:AbortSignal}
export interface RawVideoInfo {readonly codec:'rawvideo';readonly width:number;readonly height:number;readonly pixelFormat:string;readonly frameRate:Rational;readonly timeBase:Rational;readonly frameBytes:number;readonly frameCount:bigint;readonly dataBytes:bigint}
export interface RawVideoInput {readonly info:RawVideoInfo;packets(startFrame?:bigint,frameCount?:bigint):AsyncIterable<MediaPacket>}
export interface RawVideoMuxOptions {readonly frameCount:bigint;readonly timestamp?:(frame:bigint)=>bigint;readonly duration?:(frame:bigint)=>bigint;readonly maxWriteBytes:number;readonly bitexact?:boolean;readonly metadataProfile?:ReferenceMetadataProfile;readonly signal?:AbortSignal}
function parameters(format:RawVideoParameters){const layout=pixelLayout(format.pixelFormat,format.width,format.height),rate=videoFrameRate(format.frameRate);return {layout,rate,timeBase:Object.freeze({num:rate.den,den:rate.num})};}
/** Finite, declared headerless video. One semantic frame assembled from bounded range reads. */
export async function openRawVideo(input:ReadHandle,options:RawVideoOptions):Promise<RawVideoInput>{
  const {layout,rate,timeBase}=parameters(options),{maxReadBytes,maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<layout.bytes)throw new RawVideoError('Raw video frame or read exceeds allocation limit');
  if(typeof input.size!=='bigint'||input.size<0n||input.size>(1n<<63n)-1n||input.size%BigInt(layout.bytes)!==0n)throw new RawVideoError('Incomplete raw video frame or invalid input size');
  const info:RawVideoInfo=Object.freeze({codec:'rawvideo',width:layout.width,height:layout.height,pixelFormat:layout.pixelFormat,frameRate:rate,timeBase,frameBytes:layout.bytes,frameCount:input.size/BigInt(layout.bytes),dataBytes:input.size});
  return Object.freeze({info,async *packets(startFrame=0n,frameCount=info.frameCount):AsyncIterable<MediaPacket>{
    signal?.throwIfAborted();if(typeof startFrame!=='bigint'||startFrame<0n||startFrame>info.frameCount||typeof frameCount!=='bigint'||frameCount<0n)throw new RawVideoError('Invalid raw video frame range');
    const end=startFrame+frameCount<info.frameCount?startFrame+frameCount:info.frameCount;
    for(let index=startFrame;index<end;index++){
      signal?.throwIfAborted();const data=new Uint8Array(layout.bytes);let filled=0;
      while(filled<data.length){
        signal?.throwIfAborted();const length=Math.min(maxReadBytes,data.length-filled),chunk=await input.readAt(index*BigInt(layout.bytes)+BigInt(filled),length,signal);signal?.throwIfAborted();
        if(!(chunk instanceof Uint8Array)||chunk.length<1||chunk.length>length)throw new RawVideoError('Unexpected raw video read length');data.set(chunk,filled);filled+=chunk.length;
      }
      yield {streamIndex:0,data,pts:index,dts:index,duration:1n,timeBase:{...timeBase},flags:1};
    }
  }});
}
function validatePacket(packet:MediaPacket,index:bigint,layout:PixelLayout,rate:Rational,duration:bigint){
  const time=packet.timeBase,matches=(value:bigint|null,expected:bigint)=>typeof value==='bigint'&&value*time.num*rate.num===expected*time.den*rate.den;
  if(!(packet.data instanceof Uint8Array)||packet.data.length!==layout.bytes||packet.streamIndex!==0||packet.flags!==1||time.num<=0n||time.den<=0n||!matches(packet.pts,index)||!matches(packet.dts,index)||!matches(packet.duration,duration))throw new RawVideoError('Invalid raw video output packet or timestamp');
}
async function mux(output:WriteHandle,format:RawVideoParameters,packets:AsyncIterable<MediaPacket>,options:RawVideoMuxOptions,framecrc:boolean):Promise<void>{
  try{
    const {layout,rate,timeBase}=parameters(format),{frameCount,maxWriteBytes,signal,timestamp,duration}=options;signal?.throwIfAborted();const software=muxerSoftware(options.metadataProfile);
    if(typeof frameCount!=='bigint'||frameCount<0n||frameCount>(1n<<63n)-1n||!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new RawVideoError('Invalid raw video output limits');
    const write=async(data:Uint8Array)=>{for(let offset=0;offset<data.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(data.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}},encoder=new TextEncoder();
    if(framecrc){if(!options.bitexact)await write(encoder.encode('#software: '+software+'\n'));await write(encoder.encode(`#tb 0: ${timeBase.num}/${timeBase.den}\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: ${layout.width}x${layout.height}\n#sar 0: 0/1\n`));}
    let written=0n;
    for await(const packet of packets){
      signal?.throwIfAborted();if(written>=frameCount)throw new RawVideoError('Excess raw video output frames');const ptsValue=timestamp?timestamp(written):written;if(typeof ptsValue!=='bigint'||ptsValue<-(1n<<63n)||ptsValue>(1n<<63n)-1n)throw new RawVideoError('Invalid raw video output timestamp plan');const packetDuration=duration?duration(written):1n;if(typeof packetDuration!=='bigint'||packetDuration<0n||packetDuration>1n)throw new RawVideoError('Invalid raw video output duration plan');validatePacket(packet,ptsValue,layout,rate,packetDuration);
      if(framecrc){const pts=String(ptsValue).padStart(10),checksum=frameCrcChecksum(packet.data,signal).toString(16).padStart(8,'0');await write(encoder.encode(`0, ${pts}, ${pts}, ${String(packetDuration).padStart(8)}, ${String(packet.data.length).padStart(8)}, 0x${checksum}\n`));}
      else await write(packet.data);
      written++;
    }
    if(written!==frameCount)throw new RawVideoError('Raw video frame count mismatch');signal?.throwIfAborted();await output.commit();
  }catch(error){try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'Raw video output and abort failed');}throw error;}
}
export function muxRawVideo(output:WriteHandle,format:RawVideoParameters,packets:AsyncIterable<MediaPacket>,options:RawVideoMuxOptions):Promise<void>{return mux(output,format,packets,options,false);}
export function muxRawVideoFrameCrc(output:WriteHandle,format:RawVideoParameters,packets:AsyncIterable<MediaPacket>,options:RawVideoMuxOptions):Promise<void>{return mux(output,format,packets,options,true);}
