import { ExecutionError } from '@edge-ffmpeg/core';
import type { ResourceBudget } from '@edge-ffmpeg/core';
export interface PcmMemoryRequest {
  readonly budget:ResourceBudget;
  readonly channels:number;
  readonly inputBytesPerSample:number;
  readonly widestBytesPerSample:number;
  readonly copy:boolean;
  readonly remix?:boolean;
  readonly resample?:boolean;
  readonly volumeNodes:number;
  readonly reframeSamples:readonly number[];
  readonly sourceSamples:bigint;
  readonly generatedOutput?:boolean;
  readonly inputHeaderBytes:number;
  readonly outputScratchBytes:number;
}
export interface PcmMemoryPlan {
  readonly packetSamples:number;
  readonly plannedPayloadBytes:number;
  readonly heldFrameSlots:number;
  readonly components:readonly {readonly name:string;readonly bytes:number}[];
  readonly limitations:readonly string[];
}
/** Conservative scheduling reservation, not a measurement of isolate resident memory.
 * Two slots per frame-producing stage allow old/new handoff overlap; source
 * assembly/read/previous packet get three slots. Aliased metadata adds no plane.
 */
export function planPcmMemory(request:PcmMemoryRequest):PcmMemoryPlan {
  const {budget,channels,inputBytesPerSample,widestBytesPerSample,copy,volumeNodes,reframeSamples,sourceSamples,inputHeaderBytes,outputScratchBytes}=request;
  const positive=(value:number)=>Number.isSafeInteger(value)&&value>0;
  const nonnegative=(value:number)=>Number.isSafeInteger(value)&&value>=0;
  if(![budget.maxResidentBytes,budget.maxBufferBytes,budget.maxCpuTimeMs,budget.maxPendingPackets].every(positive)||budget.maxBufferBytes>budget.maxResidentBytes||!positive(channels)||![1,2,3,4,8].includes(inputBytesPerSample)||![1,2,4,8].includes(widestBytesPerSample)||(!copy&&widestBytesPerSample<(inputBytesPerSample===3?4:inputBytesPerSample))||typeof copy!=='boolean'||(request.remix!==undefined&&typeof request.remix!=='boolean')||(request.resample!==undefined&&typeof request.resample!=='boolean')||(request.generatedOutput!==undefined&&typeof request.generatedOutput!=='boolean')||!nonnegative(volumeNodes)||volumeNodes>32||!Array.isArray(reframeSamples)||reframeSamples.length>32||!reframeSamples.every(positive)||typeof sourceSamples!=='bigint'||sourceSamples<0n||(copy&&(volumeNodes!==0||reframeSamples.length!==0||request.remix||request.resample||request.generatedOutput))||!nonnegative(inputHeaderBytes)||!nonnegative(outputScratchBytes))throw new ExecutionError('resource-budget','Invalid PCM memory planning request');
  const width=BigInt(copy?inputBytesPerSample:widestBytesPerSample)*BigInt(channels);
  const maximum=BigInt(budget.maxBufferBytes)/width;
  const fixedSamples=copy?0n:BigInt(Math.max(0,...reframeSamples));
  if(maximum<1n||fixedSamples*width>BigInt(budget.maxBufferBytes))throw new ExecutionError('resource-budget','A required PCM frame exceeds the buffer budget');
  const slots=copy?0:5+2*volumeNodes+2*reframeSamples.length+(request.remix?6:0)+(request.resample?6:0);
  const components=(packet:bigint)=>{
    const frame=sourceSamples===0n&&!request.generatedOutput?0n:packet>fixedSamples?packet:fixedSamples;
    return [
      {name:'source-read-and-packet',bytes:3n*packet*BigInt(channels)*BigInt(inputBytesPerSample)},
      {name:'decoded-filter-and-codec-frames',bytes:BigInt(slots)*frame*width},
      {name:'metadata-and-mux',bytes:BigInt(inputHeaderBytes)+BigInt(outputScratchBytes)}
    ];
  };
  const total=(packet:bigint)=>components(packet).reduce((sum,entry)=>sum+entry.bytes,0n);
  const limit=BigInt(budget.maxResidentBytes);
  let selected=sourceSamples<maximum?sourceSamples:maximum;
  if(total(sourceSamples===0n?0n:1n)>limit)throw new ExecutionError('resource-budget','Estimated simultaneous PCM payload buffers exceed the resident-byte budget');
  if(total(selected)>limit){
    let low=1n,high=selected;
    while(low<high){const middle=low+(high-low+1n)/2n;if(total(middle)<=limit)low=middle;else high=middle-1n;}
    selected=low;
  }
  return Object.freeze({packetSamples:Number(selected),plannedPayloadBytes:Number(total(selected)),heldFrameSlots:slots,components:Object.freeze(components(selected).map(entry=>Object.freeze({name:entry.name,bytes:Number(entry.bytes)}))),limitations:Object.freeze(['Static conservative payload reservation; not observed heap/GC/isolate peak memory','Excludes VFS/adaptor retention, R2 multipart buffers, runtime objects and Wasm memory','Consumer retention outside the sequential backend is not bounded by this plan'])});
}
