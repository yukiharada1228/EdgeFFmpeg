import {ffmpegReferenceMuxerSoftware} from '@edge-ffmpeg/containers';
import {createH264RateProbe} from './h264-rate-probe.js';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {ExecutionError} from '@edge-ffmpeg/core';
import {frameCrcChecksum} from '@edge-ffmpeg/containers';
import {pixelLayout,reduceBoundedRational,rescale,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {Rational,VideoFrameData} from '@edge-ffmpeg/avutil';
import type {Mp4PacketHeader} from '@edge-ffmpeg/containers';
import {rawVideoOutputClock} from './video-output/output-clock.js';
import {encoderPts,roundEven} from './video-output/sync.js';
import {videoPacketDuration} from './video-output/packet-duration.js';
/** Bounded index-only clock probe. The non-fragmented MOV STTS average excludes edits. */
export function probeH264OutputClock(headers:Iterable<Mp4PacketHeader>,stream:number,maxHeaders:number,signal:AbortSignal,codecRate:Rational){
 let presentable=false;let count=0n,duration=0n,start:bigint|null=null,scanned=0;let timeBase:Rational|undefined,probe:ReturnType<typeof createH264RateProbe>|undefined,firstDuration:bigint|null=null,previousDuration:bigint|null=null,constant=true;
 for(const packet of headers){signal.throwIfAborted();if(++scanned>maxHeaders)throw new ExecutionError('resource-budget','H264 clock probe header budget exceeded');const pts=packet.pts;if(pts!==null&&!(packet.flags&4)){const us=rescale(pts,packet.timeBase,{num:1n,den:1000000n});if(start===null||us<start)start=us;}if(packet.streamIndex!==stream)continue;if(!(packet.flags&4))presentable=true;count++;duration+=packet.duration??0n;timeBase=packet.timeBase;probe??=createH264RateProbe(timeBase);probe.feed(packet.dts,packet.duration);if(firstDuration===null)firstDuration=packet.duration;if(previousDuration!==null&&previousDuration!==firstDuration)constant=false;previousDuration=packet.duration;}
 const rate=count&&duration>0n&&timeBase?reduceBoundedRational(count*timeBase.den,duration*timeBase.num):{num:0n,den:1n};return {frameRate:!presentable?{num:0n,den:1n}:probe?probe.finish(rate,codecRate,constant?firstDuration:null):{num:rate.num,den:rate.den},startTimeUs:start??0n};
}
export function createH264FrameCrcWriter(writer:WriteHandle,options:{frameRate:Rational;timeBase:Rational;startTimeUs:bigint;encoderTimeBase?:Rational|'demux'|'filter';maxWriteBytes:number;bitexact:boolean;signal:AbortSignal}){
 const clock=rawVideoOutputClock({mode:'passthrough',sinkFrameRate:options.frameRate,filterTimeBase:options.timeBase,demuxTimeBase:options.timeBase,...(options.encoderTimeBase?{encoderTimeBase:options.encoderTimeBase}:{})}),encoder=new TextEncoder();let initialized=false,lastMuxPts:bigint|undefined;
 const write=async(text:string)=>{const bytes=encoder.encode(text);for(let at=0;at<bytes.length;at+=options.maxWriteBytes){options.signal.throwIfAborted();await writer.write(bytes.subarray(at,at+options.maxWriteBytes));options.signal.throwIfAborted();}};
 const header=async(width:number,height:number,sar:Rational)=>{if(initialized)return;initialized=true;if(!options.bitexact)await write('#software: '+ffmpegReferenceMuxerSoftware+'\n');await write(`#tb 0: ${clock.timeBase.num}/${clock.timeBase.den}\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: ${width}x${height}\n#sar 0: ${sar.num}/${sar.den}\n`);};
 return {header,async frame(frame:VideoFrameData,duration:bigint|null){
  options.signal.throwIfAborted();if(!frame.pts)throw new ExecutionError('invalid-arguments','H264 framecrc requires known frame timestamps');const layout=pixelLayout(videoStoragePixelFormat(frame.pixelFormat),frame.width,frame.height),first=frame.planes[0]!;for(const [i,plane]of layout.planes.entries()){const bytes=frame.planes[i]!;if(bytes.buffer!==first.buffer||bytes.byteOffset!==first.byteOffset+plane.offset||bytes.length!==plane.bytes||frame.linesizes[i]!==plane.rowBytes)throw new ExecutionError('invalid-arguments','H264 framecrc requires owned tight frame planes');}
  const sar=(frame.metadata.sampleAspectRatio??{num:0n,den:1n}) as Rational;await header(frame.width,frame.height,sar);const rawPts=roundEven(encoderPts(frame.pts,clock.timeBase,options.startTimeUs).exact),pts=lastMuxPts===undefined?rawPts:lastMuxPts>rawPts?lastMuxPts:rawPts,ticks=roundEven(Number(duration??0n)*(Number(frame.pts.timeBase.num)/Number(frame.pts.timeBase.den))/(Number(clock.timeBase.num)/Number(clock.timeBase.den))),packetDuration=videoPacketDuration(ticks,clock.frameRate,clock.timeBase),sum=frameCrcChecksum(new Uint8Array(first.buffer,first.byteOffset,layout.bytes),options.signal).toString(16).padStart(8,'0'),stamp=String(pts).padStart(10);lastMuxPts=pts;await write(`0, ${stamp}, ${stamp}, ${String(packetDuration).padStart(8)}, ${String(layout.bytes).padStart(8)}, 0x${sum}\n`);
 }};
}
