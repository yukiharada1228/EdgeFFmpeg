import {expect,it,vi} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTimePolicy,resolveFlacTimePolicy} from '../../packages/avformat/src/flac-wave-time.js';
import {countTrimmedFlacSamples,trimFlacAudio} from '../../packages/avformat/src/flac-wave-trim.js';

const budget={maxResidentBytes:64,maxBufferBytes:32,maxPendingPackets:1,maxCpuTimeMs:10000};
const range=(startSample=0n,endSampleExclusive:bigint|null=null,outputPtsSamples=0n)=>({startSample,endSampleExclusive,outputPtsSamples});
function frame(first=0,samples=8):AudioFrameData {
 return {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples,planes:[new Uint8Array(Int16Array.from({length:samples},(_,i)=>first+i).buffer)],pts:{value:999n,timeBase:{num:1n,den:3n}}};
}
function setup(maxResidentBytes=64){
 const abort=new AbortController(),resources=new ResourceContext({...budget,maxResidentBytes},abort.signal);
 return {abort,resources,options:{resources,signal:abort.signal,maxFrameBytes:32}};
}
function source(items:AudioFrameData[]){
 const next=vi.fn(async()=>items.length?{done:false as const,value:items.shift()!}:{done:true as const,value:undefined});
 const close=vi.fn(async()=>({done:true as const,value:undefined}));
 return {next,close,frames:{[Symbol.asyncIterator]:()=>({next,return:close})}};
}

it.each([
 [0n,null,0n,0n],[0n,null,9n,9n],[3n,7n,9n,4n],[3n,7n,5n,2n],
 [9n,null,5n,0n],[3n,3n,9n,0n],[0n,100n,9n,9n],
 [9007199254740993n,null,9007199254741000n,7n],
] as const)('counts the exact bounded intersection %s..%s of %s samples',(start,end,total,expected)=>{
 expect(countTrimmedFlacSamples(total,range(start,end))).toBe(expected);
});

it('uses decoded sample ordinals, snapshots range primitives, bounds pulls and rebases PTS',async()=>{
 const run=setup(),input=source([frame(),frame(8),frame(16)]),selection=range(3n,11n,-2n),before=input.frames;
 const stream=trimFlacAudio(before,selection,run.options),iterator=stream[Symbol.asyncIterator]();
 selection.startSample=99n;selection.endSampleExclusive=100n;selection.outputPtsSamples=123n;
 const values:number[]=[],pts:bigint[]=[];
 for(;;){const item=await iterator.next();if(item.done)break;expect(run.resources.allocatedBytes).toBe(item.value.samples*2);values.push(...new Int16Array(item.value.planes[0]!.slice().buffer));expect(item.value.pts).not.toBeNull();pts.push(item.value.pts!.value);}
 expect(values).toEqual([3,4,5,6,7,8,9,10]);expect(pts).toEqual([-2n,3n]);
 expect(input.next).toHaveBeenCalledTimes(2);expect(input.close).toHaveBeenCalledOnce();expect(run.resources.allocatedBytes).toBe(0);
});

it.each(['return','abort','throw'] as const)('releases a suspended selected frame on %s',async action=>{
 const run=setup(),input=source([frame()]),iterator=trimFlacAudio(input.frames,range(1n,4n),run.options)[Symbol.asyncIterator]();
 const item=await iterator.next();expect(item.done).toBe(false);expect(run.resources.allocatedBytes).toBe(6);
 const reason=Error('stop selected PCM');
 if(action==='return')await iterator.return?.();
 else if(action==='throw')await expect(iterator.throw?.(reason)).rejects.toBe(reason);
 else{run.abort.abort(reason);await expect(iterator.next()).rejects.toBe(reason);}
 await Promise.resolve();expect(run.resources.allocatedBytes).toBe(0);expect(input.close).toHaveBeenCalledOnce();
});

it('rejects a real Core reservation over budget without retaining bytes or mutating input',async()=>{
 const run=setup(32),held=run.resources.reserveExternalMemory(30),original=frame(),bytes=original.planes[0]!.slice(),input=source([original]);
 try{await expect(trimFlacAudio(input.frames,range(),run.options)[Symbol.asyncIterator]().next()).rejects.toThrow(/budget/i);expect(run.resources.allocatedBytes).toBe(30);expect(original.planes[0]).toEqual(bytes);await Promise.resolve();expect(input.close).toHaveBeenCalledOnce();}
 finally{held();}expect(run.resources.allocatedBytes).toBe(0);
});

it.each(['resolve','reject'] as const)('cancels a pending source read and observes late %s and cleanup rejection',async late=>{
 const run=setup(),reason=Error('cancel pending trim');let resolve!:(value:IteratorResult<AudioFrameData>)=>void,reject!:(error:unknown)=>void;
 const pending=new Promise<IteratorResult<AudioFrameData>>((r,j)=>{resolve=r;reject=j;});
 const next=vi.fn(()=>pending),close=vi.fn(()=>Promise.reject(Error('late cleanup error')));
 const iterator=trimFlacAudio({[Symbol.asyncIterator]:()=>({next,return:close})},range(),run.options)[Symbol.asyncIterator]();
 const task=iterator.next(),rejected=expect(task).rejects.toBe(reason);run.abort.abort(reason);await rejected;
 if(late==='resolve')resolve({done:false,value:frame()});else reject(Error('late read error'));
 await new Promise<void>(done=>setTimeout(done,0));expect(close).toHaveBeenCalledOnce();expect(run.resources.allocatedBytes).toBe(0);
});

it('does not acquire or pull upstream for an empty range or pre-aborted execution',async()=>{
 const run=setup(),input=source([frame()]),acquire=vi.spyOn(input.frames,Symbol.asyncIterator);
 expect(await trimFlacAudio(input.frames,range(0n,0n),run.options)[Symbol.asyncIterator]().next()).toMatchObject({done:true});
 const reason=Error('already cancelled');run.abort.abort(reason);
 await expect(trimFlacAudio(input.frames,range(),run.options)[Symbol.asyncIterator]().next()).rejects.toBe(reason);
 expect(acquire).not.toHaveBeenCalled();expect(input.next).not.toHaveBeenCalled();expect(run.resources.allocatedBytes).toBe(0);
});

it.each([range(-1n),range(3n,2n)])('rejects invalid resolved sample boundaries before reading %s',selection=>{
 const run=setup(),input=source([frame()]);expect(()=>trimFlacAudio(input.frames,selection,run.options)).toThrow();expect(input.next).not.toHaveBeenCalled();expect(run.resources.allocatedBytes).toBe(0);
});

const command=(input:string[]=[],output:string[]=[])=>parseArgv([...input,'-i','/in.flac',...output,'/out']);
const resolve=(input:string[]=[],output:string[]=[],rate=8000,total:bigint|null=257n)=>resolveFlacTimePolicy(compileFlacTimePolicy(command(input,output)),rate,total);

it('compiles independent frozen scopes with last-key precedence and -t winning over -to in either order',()=>{
 for(const opts of [['-t','0.010','-to','0.001'],['-to','0.001','-t','0.010']]){
  const parsed=command(['-t','-1','-t','0.020','-ss','0.010','-ss','0'],['-ss','0.030','-ss','0.008',...opts]);
  const policy=compileFlacTimePolicy(parsed);
  expect(policy.input).toEqual({seek:0n,duration:20000n,stop:null});expect(policy.output).toEqual({seek:8000n,duration:10000n,stop:1000n});
  expect(Object.isFrozen(policy)).toBe(true);expect(Object.isFrozen(policy.input)).toBe(true);expect(Object.isFrozen(policy.output)).toBe(true);
  parsed.inputs[0]!.options.length=0;parsed.outputs[0]!.options.forEach(option=>{option.value='999';});
  expect(resolveFlacTimePolicy(policy,8000,257n)).toEqual(range(64n,144n));
 }
});

it.each([
 [[],[],257n,0n,257n],
 [['-t','0'],[],257n,0n,257n],
 [['-t','0.000001'],[],257n,0n,257n],
 [[],['-t','0'],257n,0n,0n],
 [['-t','0.010'],['-ss','0.008','-t','0.010'],257n,64n,80n],
 [[],['-ss','0.008','-to','0.001','-to','0.025'],257n,64n,200n],
 [[],['-ss','1'],257n,257n,257n],
 [[],[],0n,0n,0n],
 [[],[],null,0n,null],
 [[],['-ss','1'],null,8000n,null],
 [['-to','0.020'],['-ss','0.008','-to','0.012'],null,64n,96n],
] as [string[],string[],bigint|null,bigint,bigint|null][])('resolves scoped limits and known/unknown EOF %j %j %s',(input,output,total,start,end)=>{
 const result=resolve(input,output,8000,total);expect(result).toEqual(range(start,end));expect(Object.isFrozen(result)).toBe(true);
});

it.each([
 ['0.000062',8000,0n],['0.000062999',8000,0n],['0.000063',8000,1n],
 ['0.000187',8000,1n],['0.000188',8000,2n],['0.0625',8,1n],
 ['0.000011',44100,0n],['0.000012',44100,1n],['00:00:00.008',8000,64n],
] as const)('rounds microsecond-quantized output seek %s at %s Hz to %s samples',(time,rate,start)=>{
 expect(resolve([],['-ss',time],rate,null)).toEqual(range(start));
});

it('retains exact bigint EOF beyond Number precision',()=>{
 const total=9007199254740993n;expect(resolve([],[],655350,total)).toEqual(range(0n,total));
});

it.each(['-ss','-t','-to'])('parses every %s occurrence, including overwritten malformed tokens',name=>{
 expect(()=>compileFlacTimePolicy(command([],[name,'not-time',name,'1']))).toThrow(expect.objectContaining({code:'invalid-time'}));
});

it.each([
 [['-t','-1'],[]],[[],['-t','-1']],[['-to','0'],[]],[[],['-to','0']],
 [[],['-ss','1','-to','1']],[[],['-ss','1','-to','0.5']],
] as [string[],string[]][])('rejects Native-invalid final scoped times %j %j',(input,output)=>{
 expect(()=>compileFlacTimePolicy(command(input,output))).toThrow(expect.objectContaining({code:'invalid-time'}));
});

it.each([
 [['-ss','0.000001'],[]],[['-ss','-1'],[]],[[],['-ss','-1']],
 [['-copyts'],[]],[[],['-start_at_zero']],
] as [string[],string[]][])('exposes unsupported timestamp semantics rather than silently trimming %j %j',(input,output)=>{
 expect(()=>compileFlacTimePolicy(command(input,output))).toThrow(expect.objectContaining({code:'unsupported-command'}));
});

it('exposes positive output limits rounded to zero, not an invented frame size',()=>{
 expect(()=>resolve([],['-t','0.000001'])).toThrow(expect.objectContaining({code:'unsupported-command'}));
 expect(resolve([],['-t','0.000063'])).toEqual(range(0n,1n));
});

it.each([0,-1,1.5,NaN,Infinity,655351])('rejects invalid sample rate %s',rate=>{
 expect(()=>resolve([],[],rate)).toThrow(expect.objectContaining({code:'invalid-arguments'}));
});
it.each([-1n,1,undefined])('rejects invalid total sample count %s',total=>{
 expect(()=>resolveFlacTimePolicy(compileFlacTimePolicy(command()),8000,total as bigint)).toThrow(expect.objectContaining({code:'invalid-arguments'}));
});
