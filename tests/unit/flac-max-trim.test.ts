import {describe,expect,it,vi} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {countTrimmedFlacSamples,trimFlacAudio} from '../../packages/avformat/src/flac-wave-trim.js';

const widths={u8:1,s16:2,s32:4,flt:4,dbl:8};
function setup(resident=4096,buffer=resident){
 const controller=new AbortController();
 const resources=new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:1000},controller.signal);
 return {controller,resources};
}
function frame(format='s16',samples=4,origin=0):AudioFrameData{
 const planar=format.endsWith('p'),base=(planar?format.slice(0,-1):format) as keyof typeof widths,width=widths[base],stride=width*(planar?1:2);
 const planes=Array.from({length:planar?2:1},(_,channel)=>Uint8Array.from({length:samples*stride},(_,i)=>(origin*stride+i+channel*79)%256));
 return {sampleFormat:format,samples,channels:2,sampleRate:8000,channelLayout:'stereo',planes,pts:{value:999n-BigInt(origin),timeBase:{num:3n,den:7n}}};
}
function source(frames:AudioFrameData[],resources?:ResourceContext){
 let index=0,returns=0;const pulls:number[]=[];
 const iterator:AsyncIterableIterator<AudioFrameData>={
  [Symbol.asyncIterator](){return this;},
  async next(){pulls.push(resources?.allocatedBytes??0);const value=frames[index++];return value?{done:false,value}:{done:true,value:undefined};},
  async return(){returns++;return {done:true,value:undefined};},
 };
 return {iterator,pulls,get returns(){return returns;}};
}
const range=(startSample=0n,endSampleExclusive:bigint|null=null,outputPtsSamples=0n)=>({startSample,endSampleExclusive,outputPtsSamples});
async function collect(input:AsyncIterable<AudioFrameData>){
 const frames:AudioFrameData[]=[];
 for await(const value of input)frames.push({...value,planes:value.planes.map(plane=>plane.slice())});
 return frames;
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

describe('bounded FLAC sample trimming',()=>{
 for(const base of Object.keys(widths))for(const planar of [false,true]){
  const format=base+(planar?'p':'');
  it(`byte-exact partial leading/trailing ${format}, independent of input PTS`,async()=>{
   const {resources,controller}=setup(),input=[frame(format,4,0),frame(format,4,4),frame(format,4,8)],upstream=source(input,resources);
   const before=input.map(value=>value.planes.map(plane=>plane.slice()));
   const result=await collect(trimFlacAudio(upstream.iterator,range(2n,10n,-13n),{resources,signal:controller.signal,maxFrameBytes:128}));
   expect(result.map(value=>value.samples)).toEqual([2,4,2]);
   expect(result.map(value=>value.pts)).toEqual([-13n,-11n,-7n].map(value=>({value,timeBase:{num:1n,den:8000n}})));
   const stride=widths[base as keyof typeof widths]*(planar?1:2);
   for(let i=0;i<result.length;i++){
    const output=result[i]!;
    expect(output.sampleFormat).toBe(format);expect(output.channelLayout).toBe('stereo');expect(output.channels).toBe(2);
    for(let channel=0;channel<output.planes.length;channel++){
     expect(output.planes[channel]).toEqual(input[i]!.planes[channel]!.subarray(i===0?2*stride:0,(i===0?4:i===1?4:2)*stride));
     expect(output.planes[channel]!.buffer).not.toBe(input[i]!.planes[channel]!.buffer);
    }
   }
   expect(input.map(value=>value.planes)).toEqual(before);expect(upstream.pulls).toEqual([0,0,0]);expect(upstream.returns).toBe(1);expect(resources.allocatedBytes).toBe(0);
  });
 }
 it('accounts the exact live copy across yield and releases before pulling again',async()=>{
  const {resources,controller}=setup(64),upstream=source([frame(),frame()],resources);
  const reserve=vi.spyOn(resources,'reserveExternalMemory');
  const iterator=trimFlacAudio(upstream.iterator,range(1n,7n),{resources,signal:controller.signal,maxFrameBytes:16})[Symbol.asyncIterator]();
  const first=await iterator.next();expect(first.done).toBe(false);expect(resources.allocatedBytes).toBe(12);expect(reserve).toHaveBeenLastCalledWith(12);
  const copy=first.value!.planes[0]!.slice();upstream.iterator.next=async()=>{expect(resources.allocatedBytes).toBe(0);return {done:false,value:frame()};};
  const second=await iterator.next();expect(second.value!.samples).toBe(3);expect(first.value!.planes[0]).toEqual(copy);expect(resources.allocatedBytes).toBe(12);
  await iterator.return!();expect(resources.allocatedBytes).toBe(0);expect(upstream.returns).toBe(1);
 });
 it('does not pull for an empty origin range and does not overread an exact end',async()=>{
  for(const end of [0n,4n]){
   const {resources,controller}=setup(),upstream=source([frame(),frame()],resources);
   const values=await collect(trimFlacAudio(upstream.iterator,range(0n,end),{resources,signal:controller.signal,maxFrameBytes:16}));
   expect(values.length).toBe(end===0n?0:1);expect(upstream.pulls.length).toBe(end===0n?0:1);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('handles EOF before start, null PTS, mono, and unbounded end',async()=>{
  const {resources,controller}=setup();
  const mono={...frame('u8',3),channels:1,channelLayout:'mono',planes:[new Uint8Array([2,4,6])],pts:null};
  expect(await collect(trimFlacAudio(source([mono]).iterator,range(9n),{resources,signal:controller.signal,maxFrameBytes:3}))).toEqual([]);
  const values=await collect(trimFlacAudio(source([mono]).iterator,range(1n,null,100n),{resources,signal:controller.signal,maxFrameBytes:3}));
  expect(values[0]!.planes[0]).toEqual(new Uint8Array([4,6]));expect(values[0]!.pts!.value).toBe(100n);expect(resources.allocatedBytes).toBe(0);
 });
 it('releases on consumer break and throw without retaining the stream',async()=>{
  for(const mode of ['break','throw']){
   const {resources,controller}=setup(),upstream=source([frame(),frame()]);
   const output=trimFlacAudio(upstream.iterator,range(),{resources,signal:controller.signal,maxFrameBytes:16});
   if(mode==='break'){for await(const value of output){expect(value.samples).toBe(4);break;}}
   else {const iterator=output[Symbol.asyncIterator]();await iterator.next();const error=Error('consumer failed');await expect(iterator.throw!(error)).rejects.toBe(error);await tick();}
   expect(upstream.pulls).toHaveLength(1);expect(upstream.returns).toBe(1);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('keeps memory bounded across many frames under a one-frame resident budget',async()=>{
  const {resources,controller}=setup(16);let produced=0;
  async function* frames(){for(let i=0;i<300;i++){expect(resources.allocatedBytes).toBe(0);produced++;yield frame();}}
  let count=0;for await(const value of trimFlacAudio(frames(),range(),{resources,signal:controller.signal,maxFrameBytes:16})){expect(resources.allocatedBytes).toBe(16);count+=value.samples;}
  expect(count).toBe(1200);expect(produced).toBe(300);expect(resources.allocatedBytes).toBe(0);
 });
 for(const signalKind of ['options','resources'] as const)it(`interrupts pending next on ${signalKind} abort and observes late rejections`,async()=>{
  const {resources,controller}=setup(),external=new AbortController(),pending=deferred<IteratorResult<AudioFrameData>>(),cleanup=deferred<IteratorResult<AudioFrameData>>();
  const next=vi.fn(()=>pending.promise),finish=vi.fn(()=>cleanup.promise),upstream:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator]:()=>({next,return:finish})};
  const iterator=trimFlacAudio(upstream,range(),{resources,signal:external.signal,maxFrameBytes:16})[Symbol.asyncIterator]();
  const result=iterator.next(),error=Error('cancel pending read');const rejection=expect(result).rejects.toBe(error);
  (signalKind==='options'?external:controller).abort(error);await rejection;await tick();expect(finish).toHaveBeenCalledTimes(1);
  pending.reject(Error('late next failure'));cleanup.reject(Error('late return failure'));await tick();expect(resources.allocatedBytes).toBe(0);
 });
 it('return interrupts an outstanding read and closes upstream exactly once',async()=>{
  const {resources,controller}=setup(),pending=deferred<IteratorResult<AudioFrameData>>();
  const finish=vi.fn(async()=>({done:true as const,value:undefined}));
  const iterator=trimFlacAudio({[Symbol.asyncIterator]:()=>({next:()=>pending.promise,return:finish})},range(),{resources,signal:controller.signal,maxFrameBytes:16})[Symbol.asyncIterator]();
  const reading=iterator.next();await iterator.return!();expect((await reading).done).toBe(true);await iterator.return!();await tick();expect(finish).toHaveBeenCalledTimes(1);
  pending.resolve({done:false,value:frame()});await tick();expect(resources.allocatedBytes).toBe(0);
 });
 it('releases a yielded copy immediately when either signal aborts',async()=>{
  for(const kind of ['options','resources']){
   const {resources,controller}=setup(),external=new AbortController(),upstream=source([frame()]);
   const iterator=trimFlacAudio(upstream.iterator,range(),{resources,signal:external.signal,maxFrameBytes:16})[Symbol.asyncIterator]();
   await iterator.next();expect(resources.allocatedBytes).toBe(16);const error=Error('cancel held frame');(kind==='options'?external:controller).abort(error);
   expect(resources.allocatedBytes).toBe(0);await expect(iterator.next()).rejects.toBe(error);await tick();expect(upstream.returns).toBe(1);
  }
 });
 it('does not acquire or pull an already-cancelled source',async()=>{
  const {resources,controller}=setup(),upstream=source([frame()]),acquire=vi.fn(()=>upstream.iterator),error=Error('already cancelled');controller.abort(error);
  const iterator=trimFlacAudio({[Symbol.asyncIterator]:acquire},range(),{resources,signal:controller.signal,maxFrameBytes:16})[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toBe(error);expect(acquire).not.toHaveBeenCalled();expect(resources.allocatedBytes).toBe(0);
 });
 it('rejects frame, buffer, and resident bounds and returns the producer',async()=>{
  for(const bounds of [{resident:32,buffer:32,maxFrameBytes:15},{resident:32,buffer:8,maxFrameBytes:16},{resident:16,buffer:16,maxFrameBytes:16,held:1}]){
   const {resources,controller}=setup(bounds.resident,bounds.buffer),upstream=source([frame()]);
   const release=resources.reserveExternalMemory('held' in bounds?bounds.held!:0);
   await expect(collect(trimFlacAudio(upstream.iterator,range(),{resources,signal:controller.signal,maxFrameBytes:bounds.maxFrameBytes}))).rejects.toThrow();
   await tick();expect(upstream.returns).toBe(1);expect(resources.allocatedBytes).toBe('held' in bounds?bounds.held:0);release();expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('rejects malformed planes, unsupported formats, and changes in every format field',async()=>{
  const changes:Partial<AudioFrameData>[]=[{planes:[]},{planes:[new Uint8Array(15)]},{sampleFormat:'s24'},{samples:-1},{sampleRate:0},{channels:0},{sampleRate:16000},{sampleFormat:'s32',planes:[new Uint8Array(32)]},{channelLayout:'changed'},{channels:1,planes:[new Uint8Array(8)]}];
  for(const change of changes){
   const {resources,controller}=setup(),upstream=source([frame(),{...frame(),...change}]);
   await expect(collect(trimFlacAudio(upstream.iterator,range(),{resources,signal:controller.signal,maxFrameBytes:64}))).rejects.toThrow();await tick();expect(upstream.returns).toBe(1);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('propagates source failure and releases a previously yielded copy',async()=>{
  const {resources,controller}=setup(),error=Error('decoder failed');let closed=false;
  async function* failing(){try{yield frame();throw error;}finally{closed=true;}}
  await expect(collect(trimFlacAudio(failing(),range(),{resources,signal:controller.signal,maxFrameBytes:16}))).rejects.toBe(error);expect(closed).toBe(true);expect(resources.allocatedBytes).toBe(0);
 });
 it('validates ranges and counts intersections with bigint precision',()=>{
  const total=(1n<<60n)+9n;
  expect(countTrimmedFlacSamples(total,range(total-7n,total+3n))).toBe(7n);expect(countTrimmedFlacSamples(total,range(total+1n))).toBe(0n);expect(countTrimmedFlacSamples(12n,range(2n,7n))).toBe(5n);expect(countTrimmedFlacSamples(0n,range())).toBe(0n);
  for(const invalid of [range(-1n),range(3n,2n)]){expect(()=>countTrimmedFlacSamples(9n,invalid)).toThrow();const {resources,controller}=setup();expect(()=>trimFlacAudio(source([]).iterator,invalid,{resources,signal:controller.signal,maxFrameBytes:16})).toThrow();}
  expect(()=>countTrimmedFlacSamples(-1n,range())).toThrow();
 });
});
