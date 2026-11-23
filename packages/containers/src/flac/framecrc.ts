/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from FFmpeg 9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8
 * libavformat/framecrcenc.c and framehash.c, Copyright Fabrice Bellard.
 * Scoped FLAC audio packet copy; no side data or picture serialization.
 */
import type {WriteHandle} from '@edge-ffmpeg/core';
import type {FlacDemuxPacket} from './demux.js';
export interface FlacFrameCrcFormat {readonly sampleRate:number;readonly channelLayout:string;readonly extradata:Uint8Array;readonly streams?:number}
export interface FlacFrameCrcOptions {readonly maxWriteBytes:number;readonly signal:AbortSignal;readonly bitexact?:boolean;readonly maxPackets?:bigint}
/** Observe late provider failures while cancellation detaches the caller. */
function waitForOutput<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  void pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
  if(signal.aborted){signal.removeEventListener('abort',abort);abort();}
 });
}
function update(bytes:Uint8Array,seed:number,signal:AbortSignal){let a=seed&65535,b=seed>>>16;for(let i=0;i<bytes.length;i++){if(!(i&4095))signal.throwIfAborted();a=(a+bytes[i]!)%65521;b=(b+a)%65521;}return (b*65536+a)>>>0;}
const hex=(n:number)=>n.toString(16).padStart(8,'0');
const integer=(n:bigint|null)=>String(n??-(1n<<63n));
/** Consumes and releases each borrowed chunk before asking for the next packet. */
export async function muxFlacFrameCrc(output:WriteHandle,format:FlacFrameCrcFormat,packets:AsyncIterable<FlacDemuxPacket>,options:FlacFrameCrcOptions):Promise<void>{
 const {signal,maxWriteBytes,bitexact,maxPackets}=options;
 try{
 const {sampleRate,channelLayout,extradata}=format,streams=format.streams??1;
 if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1||!Number.isInteger(sampleRate)||sampleRate<1||!Number.isInteger(streams)||streams<1||streams>64||extradata.length!==34||!channelLayout||maxPackets!==undefined&&maxPackets<0n)throw new RangeError('Invalid FLAC framecrc parameters');
 const encoder=new TextEncoder(),write=async(text:string)=>{const bytes=encoder.encode(text);for(let at=0;at<bytes.length;at+=maxWriteBytes){signal.throwIfAborted();await waitForOutput(output.write(bytes.subarray(at,at+maxWriteBytes)),signal);signal.throwIfAborted();}};
 const crc=hex(update(extradata,0,signal));
 for(let i=0;i<streams;i++)await write(`#extradata ${i}:       34, 0x${crc}\n`);
 if(!bitexact)await write('#software: Lavf63.1.102\n');
 for(let i=0;i<streams;i++)await write(`#tb ${i}: 1/${sampleRate}\n#media_type ${i}: audio\n#codec_id ${i}: flac\n#sample_rate ${i}: ${sampleRate}\n#channel_layout_name ${i}: ${channelLayout}\n`);
 let count=0n;
 if(maxPackets!==0n)for await(const packet of packets){
 signal.throwIfAborted();let checksum=0,size=0;
 for await(const chunk of packet.chunks)try{checksum=update(chunk.data,checksum,signal);size+=chunk.data.length;}finally{chunk.release();}
 if(BigInt(size)!==packet.range.bytes)throw new Error('FLAC packet size mismatch');
 for(let i=0;i<streams;i++)await write(`${i}, ${integer(packet.dts).padStart(10)}, ${integer(packet.pts).padStart(10)}, ${integer(packet.duration??0n).padStart(8)}, ${String(size).padStart(8)}, 0x${hex(checksum)}\n`);
 if(maxPackets!==undefined&&++count>=maxPackets)break;
 }
 signal.throwIfAborted();await waitForOutput(output.commit(),signal);
 }catch(error){try{await waitForOutput(output.abort(error),signal);}catch(cleanup){if(signal.aborted&&cleanup===signal.reason)throw error;throw new AggregateError([error,cleanup],'FLAC framecrc cleanup failed');}throw error;}
}
