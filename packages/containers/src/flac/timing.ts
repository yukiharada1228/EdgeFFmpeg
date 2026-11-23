/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped adaptation of nondelayed audio fill-in and initial-duration backfill
 * from pinned libavformat/demux.c (Fabrice Bellard); see NOTICE.
 * Default FLAC sample timebase only. No nofillin/igndts/wrap/seek implementation.
 */
import type {FlacIntakeRange} from './types.js';
export interface TimedFlacRange {readonly range:FlacIntakeRange;readonly pts:bigint|null;readonly dts:bigint|null;readonly duration:bigint|null}
export class FlacTimingLimitError extends Error{}
export function createFlacPacketTiming({maxPendingPackets=128}={}){
 if(!Number.isSafeInteger(maxPendingPackets)||maxPendingPackets<1||maxPendingPackets>4096)throw new RangeError('Invalid FLAC timing pending limit');
 let pending:FlacIntakeRange[]=[],nextDts=0n,sawDuration=false,closed=false,peakPendingPackets=0;
 function packet(range:FlacIntakeRange,pts:bigint|null,duration:bigint|null):TimedFlacRange{return Object.freeze({range,pts,dts:pts,duration});}
 return {
  push(range:FlacIntakeRange){if(closed)throw new Error('FLAC timing is closed');if(!Number.isSafeInteger(range?.parserDuration)||range.parserDuration<0||(range.codecPts!==null&&typeof range.codecPts!=='bigint'))throw new TypeError('Invalid FLAC parser timing');range=Object.freeze({...range});
   if(range.parserDuration===0){if(!sawDuration){if(pending.length>=maxPendingPackets)throw new FlacTimingLimitError('FLAC initial timestamp queue limit exceeded');pending.push(range);peakPendingPackets=Math.max(peakPendingPackets,pending.length);return Object.freeze([]);}return Object.freeze([packet(range,range.codecPts,null)]);}
   const duration=BigInt(range.parserDuration),pts=range.codecPts??nextDts,result=[];
   // Initial queued packets with unknown duration are backfilled from the first
   // positive-duration packet. Later junk retains unknown timing.
   for(let i=0;i<pending.length;i++)result.push(packet(pending[i]!,pts-BigInt(pending.length-i)*duration,duration));pending=[];
   result.push(packet(range,pts,duration));nextDts=pts+duration;sawDuration=true;return Object.freeze(result);
  },
  finish(){if(closed)throw new Error('FLAC timing is closed');const result=Object.freeze(pending.map(range=>packet(range,null,null)));pending=[];closed=true;return result;},
  close(){pending=[];closed=true;},
  get metrics(){return Object.freeze({pendingPackets:pending.length,peakPendingPackets,maxPendingPackets,closed,defaultSampleTimebaseOnly:true,containerPositionImplemented:false});}
 };
}
