import {describe,expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {compileFlacAudioFilters,processFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';

function context(resident=4096,buffer=64,signal=new AbortController().signal){
 return new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:1000},signal);
}
function frame(values=[-32768,-3,-1,1,3,32767],position=0n):AudioFrameData{
 const data=new Uint8Array(values.length*2),view=new DataView(data.buffer);
 values.forEach((value,index)=>view.setInt16(index*2,value,true));
 return {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:values.length,planes:[data],pts:{value:position,timeBase:{num:1n,den:8000n}}};
}
async function* source(...frames:AudioFrameData[]){yield* frames;}
function stream(frames:AsyncIterable<AudioFrameData>,description:string,resources=context(),signal=new AbortController().signal,maxFrameBytes=64){
 return {resources,iterator:processFlacAudioFilters(frames,compileFlacAudioFilters(description,'s16'),{resources,signal,maxFrameBytes})[Symbol.asyncIterator]()};
}
async function consume(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const item of frames)result.push({...item,planes:item.planes.map(plane=>plane.slice())});return result;}
function integers(item:AudioFrameData){const bytes=item.planes[0]!,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return Array.from({length:item.samples},(_,index)=>view.getInt16(index*2,true));}

 describe('FLAC bounded filter helper plans',()=>{
 it('exposes finite count, ordered stages, rate and distinct encoder/filter formats',()=>{
  const compiled=compileFlacAudioFilters('asetrate=16000,asetnsamples=n=4:p=1,apad=pad_len=3:packet_size=2,aformat=f=dblp','s16');
  const plan=compiled.plan(5n,8000,'s16');
  expect(plan.samples).toBe(11n);expect(plan.outputRate).toBe(16000);expect(plan.sampleFormat).toBe('dblp');expect(plan.encoderSampleFormat).toBe('s16');expect(plan.requiresScalarRounding).toBe(true);
  expect(plan.buffers).toEqual([4,2]);expect(plan.stages.map(stage=>stage.outputSamples)).toEqual([5n,8n,11n,11n]);
  expect(Object.isFrozen(compiled)).toBe(true);expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.stages)).toBe(true);
 });
 it('counts duration padding at its local rate and handles bigint counts exactly',()=>{
  expect(compileFlacAudioFilters('asetrate=16000,apad=pad_dur=0.00025:packet_size=1','s32').plan(5n,8000,'s32').samples).toBe(9n);
  expect(compileFlacAudioFilters('asetnsamples=n=4:p=1','s16').plan(9007199254740993n,8000,'s16').samples).toBe(9007199254740996n);
 });
 it('rejects invalid plan dimensions and sample formats',()=>{
  const compiled=compileFlacAudioFilters('anull','s16');
  for(const count of [-1n,1 as unknown as bigint])expect(()=>compiled.plan(count,8000,'s16')).toThrow();
  for(const rate of [0,NaN,1.5,2147483648])expect(()=>compiled.plan(1n,rate,'s16')).toThrow();
  expect(()=>compiled.plan(1n,8000,'bogus' as 's16')).toThrow();
  expect(()=>compileFlacAudioFilters('anull','bogus' as 's16')).toThrow();
 });
 it.each(['','anull;anull','[in]anull[out]','volume=random(0)','volume=1:eval=frame','volume=1:precision=bogus','asetrate=0','aformat=f=bogus','asetnsamples=n=0','apad','apad=pad_len=1:whole_len=3',Array(33).fill('anull').join(',')])('rejects unsupported/unbounded syntax %s',description=>{
  expect(()=>compileFlacAudioFilters(description,'s16')).toThrow();
 });
 });

describe('FLAC filter payloads and Core ownership',()=>{
 it('passes anull through without copying, prefetch or claiming producer memory',async()=>{
  const input=frame();let pulls=0,closed=0;
  async function* producer(){try{pulls++;yield input;pulls++;yield frame();}finally{closed++;}}
  const {iterator,resources}=stream(producer(),'anull');
  expect(pulls).toBe(0);expect((await iterator.next()).value).toBe(input);expect(pulls).toBe(1);expect(resources.allocatedBytes).toBe(0);
  await iterator.return?.();expect(closed).toBe(1);expect(pulls).toBe(1);expect(resources.allocatedBytes).toBe(0);
 });
 it('reserves allocating intermediates across yield and preserves source bytes',async()=>{
  const input=frame(),original=input.planes[0]!.slice();
  const {iterator,resources}=stream(source(input),'volume=0.5:precision=fixed,aformat=f=s16');
  const next=await iterator.next();expect(next.done).toBe(false);expect(integers(next.value!)).toEqual([-16384,-1,0,1,2,16384]);
  expect(input.planes[0]).toEqual(original);expect(next.value!.planes[0]).not.toBe(input.planes[0]);expect(resources.allocatedBytes).toBeGreaterThanOrEqual(128);
  expect((await iterator.next()).done).toBe(true);expect(resources.allocatedBytes).toBe(0);
 });
 it('buffers across input boundaries, pads once, and timestamps reframed output',async()=>{
  const resources=context();
  const result=await consume(processFlacAudioFilters(source(frame([1,2,3]),frame([4,5],3n)),compileFlacAudioFilters('asetnsamples=n=4:p=1,apad=pad_len=3:packet_size=2','s16'),{resources,signal:resources.signal,maxFrameBytes:64}));
  expect(result.map(item=>item.samples)).toEqual([4,4,2,1]);expect(result.map(integers)).toEqual([[1,2,3,4],[5,0,0,0],[0,0],[0]]);
  expect(result.map(item=>item.pts?.value)).toEqual([0n,4n,8n,10n]);expect(resources.allocatedBytes).toBe(0);
 });
 it('reinterprets asetrate without copying input storage or losing bigint PTS',async()=>{
  const input=frame([1,2],9007199254740993n),{iterator,resources}=stream(source(input),'asetrate=16000');
  const output=(await iterator.next()).value!;expect(output.planes).toBe(input.planes);expect(output.sampleRate).toBe(16000);expect(output.pts).toEqual({value:9007199254740993n,timeBase:{num:1n,den:16000n}});
  await iterator.return?.();expect(resources.allocatedBytes).toBe(0);
 });
 it('releases reserved filter buffers on early return and consumer throw',async()=>{
  for(const exit of ['return','throw']){
   let closed=0;async function* producer(){try{yield frame();yield frame([1,2],6n);}finally{closed++;}}
   const {iterator,resources}=stream(producer(),'asetnsamples=n=4:p=0,volume=0.5:precision=fixed');
   await iterator.next();expect(resources.allocatedBytes).toBeGreaterThan(0);
   if(exit==='return')await iterator.return?.();else await expect(iterator.throw?.(new Error('consumer stop'))).rejects.toThrow('consumer stop');
   expect(closed).toBe(1);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('rejects an unaffordable intermediate envelope and preserves unrelated ownership',async()=>{
  const resources=context(128),unrelated=resources.allocate(1);
  const {iterator}=stream(source(frame()),'volume=0.5:precision=fixed,volume=2:precision=fixed',resources);
  await expect(iterator.next()).rejects.toThrow(/budget/i);expect(resources.allocatedBytes).toBe(1);unrelated.release();expect(resources.allocatedBytes).toBe(0);
 });
 it('accepts the exact scalar reservation budget',async()=>{
  const resources=context(64);const {iterator}=stream(source(frame()),'volume=0.5:precision=fixed',resources);
  await iterator.next();expect(resources.allocatedBytes).toBe(64);await iterator.return?.();expect(resources.allocatedBytes).toBe(0);
 });
 it.each(['asetnsamples=n=33','apad=pad_len=33:packet_size=33'])('rejects oversized FIFO/padding buffers before allocating %s',async description=>{
  const {iterator,resources}=stream(source(frame()),description);await expect(iterator.next()).rejects.toThrow(/allocation/);expect(resources.allocatedBytes).toBe(0);
 });
 it('reserves only the finite tail after validating configured packet capacity',async()=>{
  const {iterator,resources}=stream(source(frame()),'apad=pad_len=1:packet_size=32');
  try{
   expect(integers((await iterator.next()).value!)).toEqual([-32768,-3,-1,1,3,32767]);
   expect(resources.allocatedBytes).toBe(2);
   expect(integers((await iterator.next()).value!)).toEqual([0]);
   expect((await iterator.next()).done).toBe(true);
  }finally{await iterator.return?.();}
  expect(resources.allocatedBytes).toBe(0);
 });
 it('uses the tighter Core single-buffer bound for wider intermediates',async()=>{
  const resources=context(1024,16),{iterator}=stream(source(frame()),'aformat=f=dbl',resources,resources.signal,64);
  await expect(iterator.next()).rejects.toThrow(/allocation/);expect(resources.allocatedBytes).toBe(0);
 });
 it('releases reservations on malformed later planes and producer failure',async()=>{
  for(const malformed of [true,false]){
   const reason=new Error('source failed');let closed=0;
   async function* producer(){try{yield frame();if(malformed)yield {...frame(),planes:[new Uint8Array(1)]};else throw reason;}finally{closed++;}}
   const {iterator,resources}=stream(producer(),'volume=0.5:precision=fixed');await iterator.next();expect(resources.allocatedBytes).toBeGreaterThan(0);
   await expect(iterator.next()).rejects.toThrow(malformed?/planes/:/source failed/);expect(closed).toBe(1);expect(resources.allocatedBytes).toBe(0);
  }
 });
 it('rejects changing source format instead of applying an invalid fixed reservation',async()=>{
  const {iterator,resources}=stream(source(frame(),{...frame(),sampleRate:16000}),'volume=0.5:precision=fixed');await iterator.next();await expect(iterator.next()).rejects.toThrow(/Changing/);expect(resources.allocatedBytes).toBe(0);
 });
 it.each([0,-1,NaN,1.5])('rejects invalid frame limit %s without consuming input',async limit=>{
  let pulls=0;async function* producer(){pulls++;yield frame();}
  const {iterator,resources}=stream(producer(),'anull',context(),new AbortController().signal,limit);await expect(iterator.next()).rejects.toThrow();expect(pulls).toBe(0);expect(resources.allocatedBytes).toBe(0);
 });
});

describe('FLAC abort-aware source lifecycle',()=>{
 it.each(['execution','core'])('cancels blocked next/return through %s signal and observes late rejection',async kind=>{
  const execution=new AbortController(),core=new AbortController(),resources=context(4096,64,core.signal),reason=new Error('cancel filter');
  let pulls=0,returns=0,rejectNext!:(error:unknown)=>void,rejectReturn!:(error:unknown)=>void;
  const blocked=new Promise<IteratorResult<AudioFrameData>>((_resolve,reject)=>{rejectNext=reject;});
  const cleanup=new Promise<IteratorResult<AudioFrameData>>((_resolve,reject)=>{rejectReturn=reject;});
  const input:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){return {next(){pulls++;return pulls===1?Promise.resolve({done:false,value:frame()}):blocked;},return(){returns++;return cleanup;}};}};
  const {iterator}=stream(input,'volume=0.5:precision=fixed',resources,execution.signal);
  await iterator.next();expect(resources.allocatedBytes).toBeGreaterThan(0);
  const pending=iterator.next(),assertion=expect(pending).rejects.toBe(reason);
  // Allow the helper to enter the producer's pending next() before cancellation.
  for(let turn=0;turn<20&&pulls<2;turn++)await Promise.resolve();expect(pulls).toBe(2);
  (kind==='execution'?execution:core).abort(reason);await assertion;
  expect(returns).toBe(1);expect(resources.allocatedBytes).toBe(0);
  rejectNext(new Error('late source rejection'));rejectReturn(new Error('late cleanup rejection'));await new Promise(resolve=>setTimeout(resolve,0));
 });
 it('does not acquire a producer iterator when already aborted',async()=>{
  const abort=new AbortController(),reason=new Error('already stopped');abort.abort(reason);let opens=0;
  const input:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){opens++;return source()[Symbol.asyncIterator]();}};
  const {iterator,resources}=stream(input,'anull',context(),abort.signal);await expect(iterator.next()).rejects.toBe(reason);expect(opens).toBe(0);expect(resources.allocatedBytes).toBe(0);
 });
});
