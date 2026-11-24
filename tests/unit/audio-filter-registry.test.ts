import {describe,expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import {AudioFilterError,audioFilterCapabilities,compileAudioFilterChain,delayAudio,parseAudioDelay} from '@edge-ffmpeg/avfilter';
import type {AudioFilterCountPlan,AudioFilterStep} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import * as registry from '../../packages/avfilter/src/audio/registry.js';
import {compileFlacAudioFilters,processFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import {appendPacketSection,filteredPacketSchedule,schedulePacketSections} from '../../packages/avformat/src/packet-schedule.js';
import {pcmFilterMemory} from '../../packages/avformat/src/pcm-filter-memory.js';

/** Every registered descriptor with its own representative tokens: a new filter file needs no edit here. */
const examples=Object.entries(registry).flatMap(([key,descriptor])=>descriptor.examples.map(token=>[key,token] as const));
const flacTimed=(description:string)=>compileFlacTransform(parseArgv(['-i','/in.flac','-t','0.002','-af',description,'/out.pcm']),{format:'s16le',codec:'pcm_s16le'});
const flacUntimed=(description:string)=>compileFlacTransform(parseArgv(['-i','/in.flac','-af',description,'/out.pcm']),{format:'s16le',codec:'pcm_s16le'});
/** The pre-registry descriptors allowed the string format vocabulary and the negotiate/nativeFormats hooks; every other descriptor declares a native list or 'all'. */
const approximations=['adelay','aformat','volume'];
/** Tokens of the filters that predate the registry; the legacy oracle below only knows these names. */
const legacyTokens=['adelay','adelay=1S|4S','aformat','aformat=f=flt','aformat=r=8000','aformat=cl=stereo','anull','apad=pad_len=1','apad=whole_dur=0.5:packet_size=7','asetnsamples=4','asetnsamples=n=4:p=0','asetrate=16000','volume=0.5','volume=0.5:precision=fixed','volume=2:precision=double'];
const flags=['generatesOutput','reframes','allocatesFrames','formatConstraint','rateConversion','timeSelection','flacInput','stateless','changesRate'] as const;
/** The name predicates the avformat consumers used before the registry; capabilities must reproduce them exactly. */
const legacy={
 generatesOutput:(step:AudioFilterStep)=>step.name==='apad'||step.name==='adelay',
 reframes:(step:AudioFilterStep)=>step.name==='asetnsamples'||step.name==='apad'||step.name==='adelay',
 allocatesFrames:(step:AudioFilterStep)=>step.name==='volume'||step.name==='apad'||step.name==='adelay'||step.name==='aformat'&&step.sampleFormat!==null,
 formatConstraint:(step:AudioFilterStep)=>step.name==='aformat',
 rateConversion:(step:AudioFilterStep)=>step.name!=='adelay',
 timeSelection:(step:AudioFilterStep)=>!(step.name!=='anull'&&step.name!=='volume'&&step.name!=='apad'&&step.name!=='asetnsamples'&&!(step.name==='aformat'&&(step.sampleFormat!==null||step.sampleRate!==undefined||step.channelLayout!==undefined))),
 // Untimed FLAC input ran every pre-registry chain.
 flacInput:()=>true,
 stateless:(step:AudioFilterStep)=>['anull','volume','aformat','asetrate'].includes(step.name),
 changesRate:(step:AudioFilterStep)=>step.name==='asetrate'
};
function context(resident=4096,buffer=64){return new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:1000},new AbortController().signal);}
function stereo(values:readonly number[],position=0n):AudioFrameData{
 const data=new Uint8Array(values.length*2),view=new DataView(data.buffer);values.forEach((value,index)=>view.setInt16(index*2,value,true));
 return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:values.length/2,planes:[data],pts:{value:position,timeBase:{num:1n,den:8000n}}};
}
async function* source(...frames:AudioFrameData[]){yield* frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const frame of frames)result.push({...frame,planes:frame.planes.map(plane=>plane.slice())});return result;}

describe('audio filter registry',()=>{
 it('registers each descriptor under its own name with complete declarations and examples',()=>{
  for(const [key,descriptor]of Object.entries(registry)){
   expect(descriptor.name).toBe(key);expect(Object.isFrozen(descriptor)).toBe(true);expect(typeof (descriptor.apply??descriptor.stream)).toBe('function');expect(descriptor.examples.length,key).toBeGreaterThan(0);
   // Exactly one execution hook, so the stateless classification is the hook process() runs; negotiation hooks only on the pre-registry approximations.
   expect([descriptor.apply,descriptor.stream].filter(hook=>hook!==undefined).length,key).toBe(1);
   if(!approximations.includes(key))expect([descriptor.negotiate,descriptor.nativeFormats],key).toEqual([undefined,undefined]);
  }
  for(const [key,token]of examples){
   const chain=compileAudioFilterChain(token),capabilities=chain.capabilities[0]!;
   expect(chain.steps[0]!.name,token).toBe(key);expect(Object.keys(capabilities).sort(),token).toEqual([...flags].sort());expect(Object.values(capabilities).every(value=>typeof value==='boolean'),token).toBe(true);
   expect(Object.isFrozen(chain.capabilities)&&Object.isFrozen(capabilities)).toBe(true);expect(audioFilterCapabilities(chain.steps[0]!),token).toEqual(capabilities);
   // Every allocating or stream-only step reserves resident memory; generated output and cross-frame state are reframed output.
   const [reservation]=[...chain.reservations({sampleRate:8000,channels:2,sampleFormat:'s16'})];
   if(capabilities.allocatesFrames||!capabilities.stateless)expect(reservation!.frames+reservation!.buffers.length+Number(reservation!.stateBytes>0n),token).toBeGreaterThan(0);
   if(reservation!.frames>0)expect(capabilities.allocatesFrames,token).toBe(true);
   if(capabilities.generatesOutput||!capabilities.stateless)expect([capabilities.reframes,chain.reframes],token).toEqual([true,true]);
   // Generated output is declared as a count change; FLAC time selection is FLAC input evidence; a string set other than 'all' is pre-registry only.
   if(capabilities.generatesOutput)expect(typeof registry[key as keyof typeof registry].count,token).toBe('function');
   if(capabilities.timeSelection)expect(capabilities.flacInput,token).toBe(true);
   const set=(registry[key as keyof typeof registry].formats as ((step:AudioFilterStep)=>unknown)|undefined)?.(chain.steps[0]!)??'all';
   if(typeof set==='string'&&set!=='all')expect(approximations,token).toContain(key);
   // A native format list never keeps automatic rate conversion; each input format negotiates to an implemented format or refuses explicitly.
   if(chain.nativeFormatLists)expect(capabilities.rateConversion,token).toBe(false);
   for(const format of ['u8','s16','s32','flt','dbl'] as const)for(const hint of ['s16','dbl'] as const){
    let negotiated:readonly string[]|undefined;
    try{negotiated=compileAudioFilterChain(token,{outputSampleFormat:hint}).negotiatedSampleFormats(format);}catch(error){expect(error,`${token} ${format}`).toBeInstanceOf(AudioFilterError);}
    if(negotiated)expect(negotiated.length===1&&['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'].includes(negotiated[0]!),`${token} ${format}`).toBe(true);
   }
  }
 });
 it('plans every example reservation for the PCM memory plan beside its count() buffers',()=>{
  for(const [,token]of examples){
   const chain=compileAudioFilterChain(token),options={configuredInput:true,channels:2},entries=chain.plannedReservations({sampleRate:8000,channels:2,sampleFormat:'s16'},{...options,samples:1n});
   expect(entries.map(entry=>entry.step),token).toEqual(chain.steps);expect(Object.isFrozen(entries)&&entries.every(entry=>Object.isFrozen(entry)&&Object.isFrozen(entry.countBuffers)),token).toBe(true);
   expect(entries.flatMap(entry=>entry.countBuffers),token).toEqual(chain.requiredBufferSamples(1n,8000,options));
   const [{reservation}]=entries as [typeof entries[number]],memory=pcmFilterMemory(chain,{sampleRate:8000,channels:2,sampleFormat:'s16'},{...options,samples:1n},{width:8,maxBufferBytes:1<<20,maxResidentBytes:1<<22});
   // Declared frames become frame-producing stages; declared buffers and state beyond the step's own count() slots become reserved filter state.
   expect(memory.volumeNodes,token).toBe(Math.max(chain.capabilities[0]!.allocatesFrames?1:0,Math.ceil(reservation.frames/2)));
   const demand=reservation.stateBytes+reservation.buffers.reduce((sum,buffer)=>sum+BigInt(buffer.samples*buffer.copies*8),0n),held=2n*BigInt(entries[0]!.countBuffers.length*Math.max(0,...entries[0]!.countBuffers)*8);
   expect(BigInt(memory.stateBytes),token).toBe(demand>held?demand-held:0n);
  }
 });
 it('keeps the pre-registry PCM memory plan: those filters reserve nothing beyond their count() buffers',()=>{
  // Finite tails shorter than, equal to and longer than the input, rate-dependent durations, unequal delay rings and rate boundaries.
  const tokens=[...legacyTokens,'apad=whole_len=50','apad=whole_len=5000:packet_size=7','apad=pad_dur=0.01:packet_size=3','apad=whole_dur=2','adelay=0S|40S','adelay=700S|1300S|3S','adelay=10|0.5','asetnsamples=5000','aformat=f=dblp','asetrate=7999'];
  const chains=[...tokens,...tokens.flatMap((first,index)=>[`${first},${tokens[(index*7+3)%tokens.length]}`,`${tokens[(index*5+1)%tokens.length]},${first},${tokens[(index*11+2)%tokens.length]}`])];
  let checked=0;
  for(const description of chains){
   const chain=compileAudioFilterChain(description);
   for(const format of ['u8','s16','dbl'] as const)for(const channels of [1,3])for(const samples of [0n,7n,4096n,100000n])for(const output of [null,16000]){
    // The PCM path refuses an unimplemented negotiation or rate conversion before planning memory.
    const boundary=(()=>{try{chain.resolvedSampleFormat(format);return output===null?null:chain.rateBoundary(format,8000,output);}catch{return undefined;}})();
    if(boundary===undefined)continue;
    const options={...(boundary?{rateBoundary:boundary}:{}),configuredInput:true,channels},plan=chain.planSamples(samples,8000,options);
    // The narrowest PCM frame width and a buffer budget the count() buffers exactly fill: the tightest case for the new checks.
    const width=Math.max({u8:1,s16:2,dbl:8}[format],chain.maxBytesPerSample)*channels,largest=Math.max(0,...plan.buffers);
    const memory=pcmFilterMemory(chain,{sampleRate:8000,channels,sampleFormat:format},{...options,samples},{width,maxBufferBytes:Math.max(1,largest*width),maxResidentBytes:Number.MAX_SAFE_INTEGER});
    expect(memory,`${description} ${format} ${channels} ${samples} ${output}`).toEqual({volumeNodes:chain.steps.filter(legacy.allocatesFrames).length,stateBytes:0});
    checked++;
   }
  }
  expect(checked).toBe(2976);
 });
 it('refuses unproven rate conversion, FLAC input and FLAC time selection explicitly for every example',()=>{
  for(const [key,token]of examples){
   const chain=compileAudioFilterChain(token),capabilities=chain.capabilities[0]!,rate=chain.outputSampleRate(8000)+1;
   if(capabilities.rateConversion)expect(chain.rateBoundary('s16',8000,rate),token).not.toBeNull();
   else expect(()=>chain.rateBoundary('s16',8000,rate),token).toThrow(`${key} with sample rate conversion is not implemented`);
   if(capabilities.timeSelection)expect(flacTimed(token)?.timed,token).toBe(true);
   else expect(()=>flacTimed(token),token).toThrow(/additional Native packet scheduling/);
   if(capabilities.flacInput)expect(flacUntimed(token)?.filters?.steps.map(step=>step.name),token).toEqual([key]);
   else expect(()=>flacUntimed(token),token).toThrow(`FLAC input to ${key} requires additional Native evidence`);
  }
 });
 it('reproduces every former consumer name predicate through capability queries',()=>{
  const chains=[...legacyTokens,'anull,volume=0.5,aformat=f=s16,asetrate=16000','asetnsamples=4,apad=pad_len=3:packet_size=2,adelay=2S','aformat,volume=0.5:precision=fixed,adelay'];
  for(const description of chains){
   const chain=compileAudioFilterChain(description);
   for(const flag of flags){
    expect(chain.capabilities.map(capability=>capability[flag]),`${description} ${flag}`).toEqual(chain.steps.map(legacy[flag]));
    expect(chain.has(flag),`${description} ${flag}`).toBe(chain.steps.some(legacy[flag]));
   }
   expect(chain.reframes).toBe(chain.steps.some(legacy.reframes));
  }
  expect(()=>compileAudioFilterChain('anull=1')).toThrow('Unsupported audio filter: anull=1');expect(()=>compileAudioFilterChain('volumex')).toThrow('Unsupported audio filter: volumex');
 });
 it('names the stream-only filter when stateless apply() is refused',()=>{
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:1,planes:[new Uint8Array(2)],pts:null};
  expect(()=>compileAudioFilterChain('adelay=1S').apply(frame,{maxFrameBytes:16})).toThrow(/^adelay requires stream processing$/);
  expect(()=>compileAudioFilterChain('apad=pad_len=1').apply(frame,{maxFrameBytes:16})).toThrow(/^apad requires stream processing$/);
  expect(()=>compileAudioFilterChain('asetnsamples=4').apply(frame,{maxFrameBytes:16})).toThrow(/^asetnsamples requires stream processing$/);
  expect(()=>compileAudioFilterChain('volume=0.5,apad=pad_len=1,asetnsamples=4').apply(frame,{maxFrameBytes:16})).toThrow(/^apad requires stream processing$/);
 });
 it('records per-stage packet effects that the resampled packet schedule applies without filter names',()=>{
  const plan=compileAudioFilterChain('asetnsamples=4,apad=pad_len=3:packet_size=2,volume=0.5').planSamples(13n,8000);
  expect(plan.stages.map(stage=>stage.packets)).toEqual([{reframe:4n},{trailing:{samples:3n,span:2n}},undefined]);expect(Object.isFrozen(plan.stages[1]!.packets!.trailing)).toBe(true);
  const expected=appendPacketSection(schedulePacketSections([{samples:16n,span:4n}]),3n,2n),actual=filteredPacketSchedule(13n,512n,8000,8000,plan);
  expect([actual.sampleCount,actual.packetCount,actual.uniformRuns]).toEqual([expected.sampleCount,expected.packetCount,expected.uniformRuns]);
  const delayed=compileAudioFilterChain('adelay=2S|5S').planSamples(13n,8000,{channels:2});
  expect(delayed.stages[0]!.packets).toEqual({leading:{samples:2n,span:2048n},trailing:{samples:3n,span:2048n}});
  for(const description of ['adelay=2S|5S','adelay=2S','adelay=0S'])expect(()=>filteredPacketSchedule(13n,512n,8000,8000,compileAudioFilterChain(description).planSamples(13n,8000,{channels:2})),description).toThrow('adelay with sample rate conversion is not implemented');
  expect(compileAudioFilterChain('adelay=0S').planSamples(13n,8000,{channels:1}).stages[0]!.packets).toBeUndefined();
  // Leading output stays explicit even for a step that accepts rate conversion.
  const step=compileAudioFilterChain('apad=pad_len=2').steps[0]!,leading:AudioFilterCountPlan={samples:15n,buffers:[],stages:[{step,inputSamples:13n,outputSamples:15n,inputRate:8000,outputRate:8000,packets:{leading:{samples:2n,span:2n}}}]};
  expect(()=>filteredPacketSchedule(13n,512n,8000,8000,leading)).toThrow('Leading filter output requires unimplemented resampled packet scheduling');
 });
 it('names the planar-only neighbour in the fixed-volume negotiation refusal',()=>{
  expect(()=>compileAudioFilterChain('volume=0.5:precision=fixed,adelay,aformat=f=s16').resolvedSampleFormat('flt')).toThrow(/^adelay with fixed volume and an integer sample format constraint on floating input requires unimplemented format negotiation$/);
  expect(()=>compileAudioFilterChain('adelay,volume=0.5:precision=fixed,aformat=f=s16p').resolvedSampleFormat('dbl')).toThrow(/^adelay with fixed volume/);
 });
});

describe('FLAC filter reservations come from descriptors',()=>{
 it('reserves the adelay output frame and rings on the untimed path and releases them',async()=>{
  const resources=context(),compiled=compileFlacAudioFilters('adelay=1S|4S','s16'),input=[stereo([1,2,3,4,5,6]),stereo([7,8],3n)];
  const iterator=processFlacAudioFilters(source(...input),compiled,{resources,signal:resources.signal,maxFrameBytes:64})[Symbol.asyncIterator]();
  const first=await iterator.next();expect(first.done).toBe(false);
  // One 64-byte frame slot plus (4 - 1) samples of s16p ring on the second channel.
  expect(resources.allocatedBytes).toBe(70);
  const copy=(frame:AudioFrameData)=>({...frame,planes:frame.planes.map(plane=>plane.slice())}),output=[copy(first.value!)];
  for(;;){const item=await iterator.next();if(item.done)break;output.push(copy(item.value));}
  expect(resources.allocatedBytes).toBe(0);
  const native=await collect(delayAudio(source(stereo([1,2,3,4,5,6]),stereo([7,8],3n)),parseAudioDelay('adelay=1S|4S'),{maxFrameBytes:64}));
  expect(output).toEqual(native);
 });
 it('reserves configured empty-input delay silence before generating it',async()=>{
  const resources=context(),compiled=compileFlacAudioFilters('adelay=1S|4S','s16'),seen:number[]=[];
  for await(const frame of processFlacAudioFilters(source(),compiled,{resources,signal:resources.signal,maxFrameBytes:64,inputFormat:{sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:{value:0n,timeBase:{num:1n,den:8000n}}}})){seen.push(frame.samples,resources.allocatedBytes);}
  expect(seen).toEqual([1,70,3,70]);expect(resources.allocatedBytes).toBe(0);
 });
 it('rejects an unaffordable or oversized delay reservation before allocating, in step order',async()=>{
  // n=33 stereo s16 needs 132 > 64 buffer bytes, and adelay=x fails when its reservation reads the delay: whichever step comes first reports.
  for(const [description,resident,message] of [['adelay=1S|4S',69,/budget/i],['adelay=0S|40S',4096,/FLAC filter buffer exceeds allocation limit/],['asetnsamples=n=33,adelay=x',4096,/FLAC filter buffer exceeds allocation limit/],['adelay=x,asetnsamples=n=33',4096,/^Unsupported adelay delay: x$/]] as const){
   const resources=context(resident),iterator=processFlacAudioFilters(source(stereo([1,2])),compileFlacAudioFilters(description,'s16'),{resources,signal:resources.signal,maxFrameBytes:64})[Symbol.asyncIterator]();
   await expect(iterator.next(),description).rejects.toThrow(message);expect(resources.allocatedBytes,description).toBe(0);
  }
 });
});
