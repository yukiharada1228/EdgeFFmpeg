/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped packet-copy recording-time checks from fftools/ffmpeg_demux.c and
 * fftools/ffmpeg_mux.c. Native compares microsecond DTS estimates, not samples.
 */
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {FlacDemuxPacket} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
import {compileFlacTimePolicy} from './flac-wave-time.js';

/** Snapshot finite copy recording time before any provider callback. */
export function compileFlacCopyDuration(command:ParsedCommand):bigint|null {
 const policy=compileFlacTimePolicy(command);
 if(policy.output.seek!==0n)throw new ExecutionError('unsupported-command','FLAC compressed copy does not implement output seeking');
 const input=policy.input.duration,output=policy.output.duration;
 return input===null?output:output===null?input:input<output?input:output;
}

/** av_rescale_q: nearest, with exact half cases rounded away from zero. */
function microseconds(value:bigint,num:bigint,den:bigint):bigint {
 const scaled=value*num*1000000n,negative=scaled<0n,magnitude=negative?-scaled:scaled;
 const result=(magnitude+den/2n)/den;
 return negative?-result:result;
}

/** Retain whole packets strictly before the Native microsecond cutoff.
 * No payload is acquired for the first excluded packet. Closing this iterator
 * closes upstream; the demuxer retains ownership of its bounded range buffers.
 */
export async function* limitFlacCopyDuration(packets:AsyncIterable<FlacDemuxPacket>,duration:bigint|null,signal:AbortSignal):AsyncGenerator<FlacDemuxPacket,void,unknown> {
 signal.throwIfAborted();
 if(duration!==null&&duration<0n)throw new ExecutionError('invalid-time','FLAC copy duration must be non-negative');
 if(duration===0n)return;
 for await(const packet of packets){
  signal.throwIfAborted();
  if(duration!==null){
   const timeBase=packet.timeBase;
   if(packet.dts===null||!timeBase||timeBase.num<=0n||timeBase.den<=0n)throw new ExecutionError('unsupported-command','Finite FLAC copy requires known packet DTS and time base');
   if(microseconds(packet.dts,timeBase.num,timeBase.den)>=duration)return;
  }
  yield packet;
 }
}
