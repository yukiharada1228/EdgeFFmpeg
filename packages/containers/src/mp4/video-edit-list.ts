// SPDX-License-Identifier: LGPL-2.1-or-later
// Leading empty edits and per-entry time rescaling follow pinned mov.c
// get_edit_list_entry/mov_fix_index; see ../../NOTICE-MP4.
import {Mp4Error,uint,wide} from './boxes.js';import type {Box} from './boxes.js';
const MAX=(1n<<63n)-1n;
export interface VideoEditList {readonly mediaTime:bigint|null;readonly duration:bigint;readonly delay:bigint;readonly segments?:readonly {readonly mediaTime:bigint;readonly duration:bigint}[]}
/** Parse bounded presentation edits; default Native MOV ignores the rate field. */
export function readVideoEditList(data:Uint8Array,box:Box,movieScale:number,mediaScale:number,signal?:AbortSignal,maxEntries=2147483647):VideoEditList|null{
 uint(data,box,0,4);const version=data[box.data]!;if(version!==0&&version!==1)throw new Mp4Error('unsupported','Unsupported MP4 elst version');const declared=uint(data,box,4,4),stride=version?20:12,entryBytes=box.end-box.data-8,count=declared*stride===entryBytes?declared:Math.floor(entryBytes/stride);if(!Number.isSafeInteger(maxEntries)||maxEntries<1||count>maxEntries)throw new Mp4Error('resource-budget','MP4 video edit entry limit');if(count===0)return null;let delay=0n,mediaTime:bigint|null=null,duration=0n;const segments:{mediaTime:bigint;duration:bigint}[]=[];
 for(let i=0;i<count;i++){signal?.throwIfAborted();const at=8+i*stride,segment=version?wide(data,box,at):BigInt(uint(data,box,at,4)),time=version?wide(data,box,at+8,true):BigInt(uint(data,box,at+4,4)|0);uint(data,box,at+(version?16:8),4);const numerator=segment*BigInt(mediaScale),denominator=BigInt(movieScale);let scaled=(numerator+denominator/2n)/denominator;if(time>=0n&&time+scaled>MAX||time< -1n&&BigInt.asUintN(64,time+scaled)>MAX)scaled=0n;
  if(time===-1n&&mediaTime===null){delay+=scaled;if(delay>MAX)throw new Mp4Error('invalid-data','MP4 empty edit duration overflow');}
  else{if(mediaTime===null)mediaTime=time;duration+=scaled;segments.push({mediaTime:time,duration:scaled});}
 }
 return {mediaTime,duration,delay,...(segments.length>1?{segments}: {})};
}
