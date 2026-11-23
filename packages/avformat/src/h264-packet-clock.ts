// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavformat/demux.c compute_pkt_fields/select_from_pts_buffer.
// Caller supplies the active decode delay at each packet boundary.
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
export function createH264PacketClock(){
 const ptsBuffer=Array<bigint>(17).fill(MIN),errors=Array<bigint>(17).fill(0n),counts=new Uint16Array(17);let last:bigint|null=null,ordered=0,misordered=0;
 return {feed(pts:bigint|null,rawDts:bigint|null,delay:number,delayGuessed:boolean):bigint|null{
  if(!Number.isInteger(delay)||delay<0||delay>16)throw Error('Invalid H264 packet reorder delay');for(const value of [pts,rawDts])if(value!==null&&(value<=MIN||value>MAX))throw Error('Invalid H264 packet timestamp');
  let dts=rawDts;
  if(dts!==null){if(dts===pts&&last!==null){if(last<=dts)ordered++;else misordered++;if(ordered+misordered>250){ordered>>=1;misordered>>=1;}}last=dts;if(ordered<8*misordered&&dts===pts)dts=null;}
  if(pts!==null){ptsBuffer[0]=pts;for(let i=0;i<delay&&ptsBuffer[i]!>ptsBuffer[i+1]!;i++)[ptsBuffer[i],ptsBuffer[i+1]]=[ptsBuffer[i+1]!,ptsBuffer[i]!];
   if(delayGuessed){if(dts===null){let best=MAX;for(let i=0;i<delay;i++)if(counts[i]){const score=errors[i]!/BigInt(counts[i]!);if(score<best){best=score;dts=ptsBuffer[i]===MIN?null:ptsBuffer[i]!;}}}else for(let i=0;i<delay;i++)if(ptsBuffer[i]!==MIN){const difference=ptsBuffer[i]!>dts?ptsBuffer[i]!-dts:dts-ptsBuffer[i]!;errors[i]=difference>MAX-errors[i]!?MAX:errors[i]!+difference;counts[i]=counts[i]!+1;if(counts[i]!>250){errors[i]=errors[i]!>>1n;counts[i]=counts[i]!>>1;}}
    if(dts===null)dts=ptsBuffer[0]===MIN?null:ptsBuffer[0]!;
   }
  }
  return dts;
 }};
}
