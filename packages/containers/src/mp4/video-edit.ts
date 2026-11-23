// SPDX-License-Identifier: LGPL-2.1-or-later
// Single-edit index reconstruction follows pinned libavformat/mov.c
// mov_fix_index/find_prev_closest_index; see NOTICE-MP4.
import {Mp4Error} from './boxes.js';
const MAX=(1n<<63n)-1n;
function checked(value:bigint):bigint{if(value< -MAX||value>MAX)throw new Mp4Error('invalid-data','MP4 video edit timestamp overflow');return value;}
export function applyVideoEdit(dts:BigInt64Array,pts:BigInt64Array,durations:Uint32Array,flags:Uint8Array,mediaTime:bigint,editDuration:bigint,dtsShift:bigint,hasComposition:boolean,signal?:AbortSignal,initialDelay=0n,normalize=true):{start:number;end:number;minimum:bigint}{
 const intervalEnd=mediaTime+editDuration;if(intervalEnd<-(1n<<63n)||intervalEnd>MAX)throw new Mp4Error('invalid-data','MP4 video edit interval overflow');const count=dts.length;let start=0,found=false;
 for(let i=0;i<count;i++){signal?.throwIfAborted();if(dts[i]!<=mediaTime-dtsShift&&(flags[i]!&1)&&(!hasComposition||pts[i]!<=mediaTime)){if(!found||dts[i]!==dts[start])start=i;found=true;}}
 if(!found)start=0;let end=count,afterKey=false;
 for(let i=start;i<count;i++){const frameDuration=i+1<count?dts[i+1]!-dts[i]!:editDuration;if(pts[i]!+frameDuration>=mediaTime+editDuration&&(flags[i]!&1)){if(hasComposition&&!afterKey){afterKey=true;continue;}end=i+1;break;}}
 let counter=initialDelay-dtsShift,entered=false,minimum=-1n;
 for(let i=start;i<end;i++){signal?.throwIfAborted();const oldDts=dts[i]!,oldPts=pts[i]!,offset=oldPts-oldDts,frameDuration=i+1<count?dts[i+1]!-oldDts:editDuration,inRange=oldPts>=mediaTime&&oldPts<mediaTime+editDuration;
  if(!inRange)flags[i]=flags[i]!|4;
  else{const corrected=counter+offset;if(minimum<0n||corrected<minimum)minimum=corrected;if(!entered){entered=true;let previous=counter;for(let j=i-1;j>=start;j--){signal?.throwIfAborted();previous-=BigInt(durations[j]!);const delta=previous-dts[j]!;dts[j]=checked(previous);pts[j]=checked(pts[j]!+delta);}}}
  dts[i]=checked(counter);pts[i]=checked(counter+offset);if(entered)counter+=frameDuration;
 }
 const correctedMinimum=minimum;minimum-=initialDelay;if(normalize&&minimum>0n)for(let i=start;i<end;i++){signal?.throwIfAborted();dts[i]=checked(dts[i]!-minimum);pts[i]=checked(pts[i]!-minimum);}
 return {start,end,minimum:correctedMinimum};
}
