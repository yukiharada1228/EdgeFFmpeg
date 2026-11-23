// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavformat/mov.c mov_estimate_video_delay; see NOTICE-MP4-COPY.
import type {Mp4PacketHeader} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
/** Constant-space MOV/H264 PTS insertion-depth estimate over indexed packets. */
export function estimateMp4H264Delay(headers:Iterable<Mp4PacketHeader>,streamIndex:number,maxHeaders:number,signal?:AbortSignal):number {
 signal?.throwIfAborted();if(!Number.isSafeInteger(streamIndex)||streamIndex<0||!Number.isSafeInteger(maxHeaders)||maxHeaders<1)throw new ExecutionError('resource-budget','Invalid MP4 delay probe budget');
 const minimum=-(1n<<63n),maximum=(1n<<63n)-1n,buffer=Array<bigint>(17).fill(minimum);let start=0,delay=0,count=0;
 for(const packet of headers){signal?.throwIfAborted();if(++count>maxHeaders)throw new ExecutionError('resource-budget','MP4 delay probe packet budget exceeded');if(packet.streamIndex!==streamIndex)continue;
  if(typeof packet.pts!=='bigint'||packet.pts<minimum||packet.pts>maximum)throw new ExecutionError('invalid-arguments','Invalid MP4 delay probe PTS');
  let j=start;start=(start+1)%17;buffer[j]=packet.pts;let swaps=0;
  while(j!==start){const previous=(j+16)%17;if(buffer[j]!>=buffer[previous]!)break;[buffer[j],buffer[previous]]=[buffer[previous]!,buffer[j]!];swaps++;j=previous;}
  delay=Math.max(delay,swaps);
 }
 return delay;
}
