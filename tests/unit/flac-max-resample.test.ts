import {expect,it} from 'vitest';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {ResourceContext} from '@edge-ffmpeg/core';
import {countResampledFlacSamples,resampleFlacAudio} from '../../packages/avformat/src/flac-wave-resample.js';
import {planAudioResample,resampleAudio,resampledSampleCount,resampledStreamingSampleCount} from '@edge-ffmpeg/swresample';

const limits={maxFrameBytes:512,maxStateBytes:1048576,sampleFormat:'flt' as const};
function context(resident=1048576,buffer=512,signal=new AbortController().signal){return new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:1,maxCpuTimeMs:10000},signal);}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function frame(samples:number,position=0,rate=8000):AudioFrameData{
 const data=new Uint8Array(samples*4),view=new DataView(data.buffer);
 for(let index=0;index<samples;index++)view.setFloat32(index*4,((position+index)%31-15)/32,true);
 return {sampleRate:rate,channels:1,channelLayout:'mono',sampleFormat:'flt',samples,planes:[data],pts:{value:BigInt(position),timeBase:{num:1n,den:BigInt(rate)}}};
}
async function* partition(samples:number,chunk:number,rate=8000):AsyncIterable<AudioFrameData>{
 for(let position=0;position<samples;position+=chunk)yield frame(Math.min(chunk,samples-position),position,rate);
}
async function render(samples:number,chunk:number,inputRate:number,outputRate:number){
 const resources=context();
 const result:AudioFrameData[]=[];
 for await(const output of resampleFlacAudio(partition(samples,chunk,inputRate),outputRate,'flt',{resources,signal:resources.signal,maxFrameBytes:limits.maxFrameBytes}))result.push({...output,planes:output.planes.map(plane=>plane.slice())});
 expect(resources.allocatedBytes).toBe(0);
 return result;
}
function bytes(frames:AudioFrameData[]):Uint8Array{
 const output=new Uint8Array(frames.reduce((sum,item)=>sum+item.planes[0]!.length,0));let offset=0;
 for(const item of frames){output.set(item.planes[0]!,offset);offset+=item.planes[0]!.length;}
 return output;
}

it('counts finite FLAC tails using the existing FIR flush, not the rounded rate ratio',async()=>{
 for(const [samples,inputRate,outputRate,expected] of [[0,8000,16000,0],[1,8000,16000,0],[21,8000,16000,0],[24,8000,16000,40],[32,8000,16000,64],[42,48000,44100,38],[19,8000,8000,19]]){
  const planned=countResampledFlacSamples(BigInt(samples!),inputRate!,outputRate!);
  expect(planned).toBe(BigInt(expected!));
  const result=await render(samples!,7,inputRate!,outputRate!);
  expect(result.reduce((sum,item)=>sum+BigInt(item.samples),0n)).toBe(planned);
 }
});

it('keeps FIR initialization and drain independent of physical FLAC chunk boundaries',async()=>{
 for(const [inputRate,outputRate,samples] of [[8000,16000,24],[48000,44100,91],[44100,48000,257]]){
  const whole=await render(samples!,128,inputRate!,outputRate!);
  for(const chunk of [1,7,31]){
   const fragmented=await render(samples!,chunk,inputRate!,outputRate!);
   expect(bytes(fragmented)).toEqual(bytes(whole));
   let emitted=0n;
   for(const item of fragmented){
    expect(item.pts).toEqual({value:emitted,timeBase:{num:1n,den:BigInt(outputRate!)}});
    expect(item.planes[0]!.length).toBeLessThanOrEqual(limits.maxFrameBytes);
    emitted+=BigInt(item.samples);
   }
   expect(emitted).toBe(resampledSampleCount(BigInt(samples!),inputRate!,outputRate!));
  }
 }
});

it('does not publish a reflected EOF tail before upstream reaches EOF',async()=>{
 let finish!:()=>void,requested=0;
 const eof=new Promise<void>(resolve=>{finish=resolve;});
 async function* source(){requested++;yield frame(24);requested++;await eof;}
 const iterator=resampleAudio(source(),16000,limits)[Symbol.asyncIterator]();
 let settled=false;const pending=iterator.next().then(value=>{settled=true;return value;});
 await new Promise<void>(resolve=>setTimeout(resolve,0));
 expect(requested).toBe(2);expect(settled).toBe(false);
 expect(resampledStreamingSampleCount(24n,8000,16000)).toBe(0n);
 finish();const output=await pending;
 expect(output.done).toBe(false);expect(output.value!.samples).toBe(40);
 expect((await iterator.next()).done).toBe(true);
});

it('retains bigint precision in the finite sample count planner',()=>{
 const samples=9007199254740993n;
 expect(resampledSampleCount(samples,8000,16000)).toBe(samples*2n);
 expect(resampledSampleCount(samples,48000,48000)).toBe(samples);
 for(const count of [-1n,1 as unknown as bigint])expect(()=>resampledSampleCount(count,8000,16000)).toThrow();
 for(const rate of [0,-1,NaN,Infinity,1.5,2147483648])expect(()=>resampledSampleCount(1n,rate,8000)).toThrow();
});

it('plans bounded filter history and coefficients rather than whole-stream storage',()=>{
 for(const [inputRate,outputRate,channels] of [[8000,16000,1],[48000,8000,2],[44100,48001,2]]){
  const plan=planAudioResample(inputRate!,outputRate!,channels!,limits);
  expect(plan.historySamples).toBe(2*plan.taps+2);
  expect(plan.phases).toBeLessThanOrEqual(1024);
  expect(plan.stateBytes).toBe(plan.coefficientBytes+plan.historySamples*channels!*4);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(()=>planAudioResample(inputRate!,outputRate!,channels!,{...limits,maxStateBytes:plan.stateBytes-1})).toThrow();
  expect(planAudioResample(inputRate!,outputRate!,channels!,{...limits,maxStateBytes:plan.stateBytes})).toEqual(plan);
 }
});

it('holds a real reservation while yielding without mutating producer storage',async()=>{
 const resources=context(),input=frame(16),original=input.planes[0]!.slice();let pulls=0,closed=0;
 const source=(async function*(){try{pulls++;yield input;pulls++;yield frame(16,16);}finally{closed++;}})();
 const output=resampleFlacAudio(source,8000,'dbl',{resources,signal:resources.signal,maxFrameBytes:64})[Symbol.asyncIterator]();
 expect(pulls).toBe(0);const first=await output.next();expect(first.done).toBe(false);expect(first.value!.samples).toBe(8);expect(first.value!.planes[0]!.byteLength).toBe(64);
 expect(resources.allocatedBytes).toBe(192);expect(pulls).toBe(1);expect(first.value!.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 first.value!.planes[0]!.fill(0);expect(input.planes[0]).toEqual(original);
 await output.return!();await tick();expect(closed).toBe(1);expect(resources.allocatedBytes).toBe(0);
});

it('rejects before allocation when the real Core resident envelope cannot fit',async()=>{
 const resources=context(191,64);let closed=false;
 const source=(async function*(){try{yield frame(8);}finally{closed=true;}})();
 const output=resampleFlacAudio(source,8000,'flt',{resources,signal:resources.signal,maxFrameBytes:64})[Symbol.asyncIterator]();
 await expect(output.next()).rejects.toThrow('Memory budget');expect(closed).toBe(true);expect(resources.allocatedBytes).toBe(0);
});

it.each(['u8','u8p','s16','s16p','s32','s32p','flt','fltp','dbl','dblp'] as const)('accepts bounded %s sources and independently owns same-rate output',async sampleFormat=>{
 const width=sampleFormat.startsWith('u8')?1:sampleFormat.startsWith('s16')?2:sampleFormat.startsWith('dbl')?8:4,planar=sampleFormat.endsWith('p');
 const input:AudioFrameData={...frame(2),channels:2,channelLayout:'stereo',sampleFormat,planes:Array.from({length:planar?2:1},()=>new Uint8Array(2*(planar?1:2)*width))};
 const resources=context(),source=(async function*(){yield input;})();let samples=0;
 for await(const output of resampleFlacAudio(source,8000,sampleFormat,{resources,signal:resources.signal,maxFrameBytes:512})){
  expect(output.planes).toEqual(input.planes);for(let i=0;i<output.planes.length;i++)expect(output.planes[i]!.buffer).not.toBe(input.planes[i]!.buffer);samples+=output.samples;
 }
 expect(samples).toBe(2);expect(resources.allocatedBytes).toBe(0);
});

it.each(['pts','rate','format','planes','aggregate'] as const)('rejects invalid/changing %s without leaking a reservation',async defect=>{
 const resources=context(),second={...frame(8,8)};
 if(defect==='pts')second.pts={value:9n,timeBase:{num:1n,den:8000n}};
 if(defect==='rate')second.sampleRate=16000;
 if(defect==='format')second.sampleFormat='s32';
 if(defect==='planes')second.planes=[new Uint8Array(1)];
 if(defect==='aggregate'){second.samples=129;second.planes=[new Uint8Array(516)];}
 const source=(async function*(){yield frame(8);yield second;})();
 await expect((async()=>{for await(const item of resampleFlacAudio(source,8000,'flt',{resources,signal:resources.signal,maxFrameBytes:512}))expect(item.samples).toBe(8);})()).rejects.toThrow();
 expect(resources.allocatedBytes).toBe(0);
});

it('is one-shot, rejects concurrent pulls, and observes late source rejection after cancellation',async()=>{
 const resources=context(),abort=new AbortController(),reason=Error('cancel resample');let reject!:(error:Error)=>void,started!:()=>void,closed=0;
 const ready=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<IteratorResult<AudioFrameData>>((_resolve,fail)=>{reject=fail;});
 const source:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){return {next(){started();return pending;},async return(){closed++;return {done:true,value:undefined};}};}};
 const stream=resampleFlacAudio(source,16000,'flt',{resources,signal:abort.signal,maxFrameBytes:512}),output=stream[Symbol.asyncIterator]();
 expect(()=>stream[Symbol.asyncIterator]()).toThrow('one-shot');
 const task=output.next();await ready;await expect(output.next()).rejects.toThrow('Concurrent');abort.abort(reason);await expect(task).rejects.toBe(reason);
 reject(Error('late producer rejection'));await tick();expect(closed).toBe(1);expect(resources.allocatedBytes).toBe(0);
});

it.each(['option','resources'] as const)('cancels via %s signal while retaining the lease until upstream cleanup settles',async channel=>{
 const abort=new AbortController(),resourceAbort=new AbortController(),resources=context(1048576,512,resourceAbort.signal);let finish!:()=>void,closing!:()=>void;
 const cleanup=new Promise<void>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{closing=resolve;});
 const source=(async function*(){try{yield frame(8);}finally{closing();await cleanup;}})();
 const output=resampleFlacAudio(source,8000,'flt',{resources,signal:abort.signal,maxFrameBytes:512})[Symbol.asyncIterator]();
 await output.next();expect(resources.allocatedBytes).toBe(1536);const reason=Error('cancel held output');(channel==='option'?abort:resourceAbort).abort(reason);
 await started;await expect(output.next()).rejects.toBe(reason);expect(resources.allocatedBytes).toBe(1536);finish();await tick();expect(resources.allocatedBytes).toBe(0);
});

it('does not flush a finite FIR tail on early consumer return',async()=>{
 const resources=context();let closed=0;
 const source=(async function*(){try{yield frame(128);yield frame(128,128);}finally{closed++;}})();
 const output=resampleFlacAudio(source,16000,'flt',{resources,signal:resources.signal,maxFrameBytes:512})[Symbol.asyncIterator]();
 expect((await output.next()).done).toBe(false);await output.return!();expect((await output.next()).done).toBe(true);await tick();expect(closed).toBe(1);expect(resources.allocatedBytes).toBe(0);
});
