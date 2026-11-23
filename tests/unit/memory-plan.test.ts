import { expect,it } from 'vitest';
import { planPcmMemory } from '@edge-ffmpeg/avformat';
import type { PcmMemoryRequest } from '@edge-ffmpeg/avformat';
const request:PcmMemoryRequest={budget:{maxResidentBytes:128,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000},channels:1,inputBytesPerSample:1,widestBytesPerSample:1,copy:false,volumeNodes:0,reframeSamples:[],sourceSamples:1000n,inputHeaderBytes:0,outputScratchBytes:0};
it('shrinks packet size to fit an aggregate conservative payload reservation',()=>{
  const plan=planPcmMemory(request);expect(plan.packetSamples).toBe(16);expect(plan.plannedPayloadBytes).toBe(128);expect(plan.components.reduce((sum,entry)=>sum+entry.bytes,0)).toBe(128);expect(Object.isFrozen(plan.components)).toBe(true);
  expect(planPcmMemory({...request,sourceSamples:10n}).packetSamples).toBe(10);expect(planPcmMemory({...request,sourceSamples:0n}).plannedPayloadBytes).toBe(0);
  const copy=planPcmMemory({...request,copy:true});expect(copy.packetSamples).toBe(42);expect(copy.heldFrameSlots).toBe(0);
});
it('rejects aggregate FIFO work even when individual buffers fit',()=>{
  expect(()=>planPcmMemory({...request,reframeSamples:[16,16]})).toThrow('simultaneous');
  expect(()=>planPcmMemory({...request,reframeSamples:[65]})).toThrow('buffer budget');
  expect(()=>planPcmMemory({...request,sourceSamples:0n,outputScratchBytes:129})).toThrow('simultaneous');
  expect(()=>planPcmMemory({...request,volumeNodes:-1})).toThrow('Invalid');
});
it('uses bigint intermediate arithmetic for large resource requests',()=>{
  const plan=planPcmMemory({...request,budget:{...request.budget,maxBufferBytes:9007199254740991,maxResidentBytes:9007199254740991},sourceSamples:1n<<62n,volumeNodes:32});
  expect(Number.isSafeInteger(plan.packetSamples)).toBe(true);expect(Number.isSafeInteger(plan.plannedPayloadBytes)).toBe(true);expect(plan.plannedPayloadBytes).toBeLessThanOrEqual(9007199254740991);
});
it('reserves generated padding frames even when the configured source has no payload samples',()=>{
  const empty={...request,budget:{...request.budget,maxResidentBytes:100},sourceSamples:0n,generatedOutput:true,reframeSamples:[16]};expect(()=>planPcmMemory(empty)).toThrow('simultaneous');
  const plan=planPcmMemory({...empty,budget:{...request.budget,maxResidentBytes:256}});expect(plan.packetSamples).toBe(0);expect(plan.plannedPayloadBytes).toBe(112);expect(plan.components.find(value=>value.name==='source-read-and-packet')!.bytes).toBe(0);
});
