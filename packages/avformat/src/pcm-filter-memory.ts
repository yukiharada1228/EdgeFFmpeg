import {ExecutionError} from '@edge-ffmpeg/core';
import type {AudioFilterChain,AudioPadFormat,AudioReservationPlan} from '@edge-ffmpeg/avfilter';
export interface PcmFilterMemory {
 /** Frame-producing stages for planPcmMemory: each allocatesFrames step, or every two declared frames. */
 readonly volumeNodes:number;
 /** Declared buffers and state beyond the steps' own count() slots, reserved before the payload plan. */
 readonly stateBytes:number;
}
export interface PcmFilterMemoryLimits {
 /** Widest sample width times the widest channel count: planPcmMemory's frame width. */
 readonly width:number;
 readonly maxBufferBytes:number;
 /** Resident bytes left for payload and filter state (after resampler state). */
 readonly maxResidentBytes:number;
}
/**
 * PCM slot-model inputs read from the same descriptor reservations the FLAC
 * helper reserves. planPcmMemory gives each frame-producing stage two frame
 * slots and each count() buffer two slots of at least the largest buffer, so a
 * step's reserved buffers and state fitting its own count() slots add nothing;
 * the rest is resident filter state outside the payload plan.
 */
export function pcmFilterMemory(chain:AudioFilterChain,input:Pick<AudioPadFormat,'sampleRate'|'channels'|'sampleFormat'>,plan:AudioReservationPlan,limits:PcmFilterMemoryLimits):PcmFilterMemory {
 const entries=chain.plannedReservations(input,plan),width=BigInt(limits.width),maxBuffer=BigInt(limits.maxBufferBytes);
 const largest=BigInt(Math.max(0,...entries.flatMap(entry=>entry.countBuffers)));
 let volumeNodes=0,state=0n;
 for(const [index,{reservation:{frames,buffers,stateBytes},countBuffers}] of entries.entries()){
  volumeNodes+=Math.max(chain.capabilities[index]!.allocatesFrames?1:0,Math.ceil(frames/2));
  let demand=stateBytes;
  if(stateBytes>maxBuffer)throw new ExecutionError('resource-budget','Audio filter state exceeds the configured buffer budget');
  for(const {samples,copies} of buffers){
   const bytes=BigInt(samples)*width;
   if(bytes>maxBuffer)throw new ExecutionError('resource-budget','Audio filter state exceeds the configured buffer budget');
   demand+=bytes*BigInt(copies);
  }
  const held=2n*BigInt(countBuffers.length)*largest*width;
  if(demand>held)state+=demand-held;
 }
 if(volumeNodes>32)throw new ExecutionError('resource-budget','Audio filter frame reservations exceed the PCM plan limit');
 if(state>0n&&state+maxBuffer>BigInt(limits.maxResidentBytes))throw new ExecutionError('resource-budget','Audio filter state and one payload buffer exceed the resident-byte budget');
 return Object.freeze({volumeNodes,stateBytes:Number(state)});
}
