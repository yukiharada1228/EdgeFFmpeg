import {ffmpegReferenceMuxerSoftware} from '@edge-ffmpeg/containers';
// Experimental bounded variable-size rawvideo mux; fixed header geometry.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {MediaPacket,Rational} from '@edge-ffmpeg/avutil';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {frameCrcChecksum} from '@edge-ffmpeg/containers';
export async function muxTimedRawVideo(output:WriteHandle,packets:AsyncIterable<MediaPacket>,options:{readonly sampleAspectRatio?:Rational;readonly maxPacketBytes:number;readonly width:number;readonly height:number;readonly pixelFormat:string;readonly timeBase:Rational;readonly framecrc:boolean;readonly bitexact:boolean;readonly maxWriteBytes:number;readonly signal:AbortSignal}){
 const {signal,timeBase}=options,layout=pixelLayout(options.pixelFormat,options.width,options.height),sar=options.sampleAspectRatio?{...options.sampleAspectRatio}:{num:0n,den:1n};let count=0n,previous:bigint|null=null;
 try{
  if(typeof sar.num!=='bigint'||typeof sar.den!=='bigint'||sar.num<0n||sar.num>2147483647n||sar.den<=0n||sar.den>2147483647n)throw new Error('Invalid mux sample aspect ratio');
  if(!Number.isSafeInteger(options.maxPacketBytes)||options.maxPacketBytes<layout.bytes||!Number.isSafeInteger(options.maxWriteBytes)||options.maxWriteBytes<1||timeBase.num<=0n||timeBase.den<=0n)throw new Error('Invalid timed rawvideo mux configuration');
  const write=async(data:Uint8Array)=>{for(let offset=0;offset<data.length;offset+=options.maxWriteBytes){signal.throwIfAborted();await output.write(data.subarray(offset,offset+options.maxWriteBytes));signal.throwIfAborted();}},text=new TextEncoder();
  if(options.framecrc){if(!options.bitexact)await write(text.encode('#software: '+ffmpegReferenceMuxerSoftware+'\n'));await write(text.encode(`#tb 0: ${timeBase.num}/${timeBase.den}\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: ${layout.width}x${layout.height}\n#sar 0: ${sar.num}/${sar.den}\n`));}
  for await(const packet of packets){signal.throwIfAborted();if(packet.streamIndex!==0||packet.flags!==1||packet.data.length>options.maxPacketBytes||packet.timeBase.num!==timeBase.num||packet.timeBase.den!==timeBase.den||packet.pts===null||packet.dts!==packet.pts||packet.duration===null||packet.duration<0n||previous!==null&&packet.pts<previous)throw new Error('Invalid timed rawvideo output packet');
   previous=packet.pts;if(options.framecrc){const pts=String(packet.pts).padStart(10),checksum=frameCrcChecksum(packet.data,signal).toString(16).padStart(8,'0');await write(text.encode(`0, ${pts}, ${pts}, ${String(packet.duration).padStart(8)}, ${String(packet.data.length).padStart(8)}, 0x${checksum}\n`));}else await write(packet.data);count++;
  }
  signal.throwIfAborted();await output.commit();return count;
 }catch(error){try{await output.abort(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Timed rawvideo mux and cleanup failed');}throw error;}
}
