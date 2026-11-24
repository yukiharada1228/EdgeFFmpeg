import {describe,expect,it,vi} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ResourceBudget,VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {audioFilterCapabilities,compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import {pcmFilterMemory} from '../../packages/avformat/src/pcm-filter-memory.js';
import {collectingOutput} from '../helpers/output.js';

/** Formats the scratch native-list stream filter was asked to work in. */
const worked=vi.hoisted(()=>[] as string[]);
// Scratch filters added exactly as a new filter is: one descriptor each, listed only in the registry module.
vi.mock('../../packages/avfilter/src/audio/registry.js',async importOriginal=>{
 const {AudioFilterError,defineAudioFilter,frameReservation}=await import('../../packages/avfilter/src/audio/descriptor.js');
 const {convertAudioFrame}=await import('@edge-ffmpeg/swresample');
 const only=(name:string)=>(text:string)=>{if(text!==name)throw new AudioFilterError(`Unsupported audio filter: ${text}`);return Object.freeze({name});};
 return {...await importOriginal<Record<string,unknown>>(),
  // Stream-only s16 mono state across frames: each output sample is the previous input sample. Declares reframes:false on purpose.
  aprev:defineAudioFilter({name:'aprev',examples:['aprev'],parse:only('aprev'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   count:(_step,samples)=>({samples,buffers:[1]}),
   async *stream(_step,frames,options){
    let previous=0;
    for await(const frame of frames){
     options.signal?.throwIfAborted();
     const plane=frame.planes[0]!,input=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),data=new Uint8Array(plane.length),output=new DataView(data.buffer);
     for(let index=0;index<frame.samples;index++){output.setInt16(index*2,previous,true);previous=input.getInt16(index*2,true);}
     yield {...frame,planes:[data]};
    }
   },
   reserve:()=>({frames:1,buffers:[],stateBytes:2n})}),
  // Changes the count without declaring its packet effect.
  askew:defineAudioFilter({name:'askew',examples:['askew'],parse:only('askew'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:true,timeSelection:false}),
   count:(_step,samples)=>({samples:samples+1n,buffers:[]}),apply:(_step,frame)=>frame}),
  // Stream-only pass-through whose history is declared only in reserve(): no count() buffer holds it.
  ahist:defineAudioFilter({name:'ahist',examples:['ahist'],parse:only('ahist'),
   capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:false,formatConstraint:false,rateConversion:false,timeSelection:false}),
   async *stream(_step,frames,options){for await(const frame of frames){options.signal?.throwIfAborted();yield frame;}},
   reserve:()=>({frames:0,buffers:[],stateBytes:3000n})}),
  // Stateless s16 mono samples from the frame timestamp: time-dependent output declares reframes.
  aclock:defineAudioFilter({name:'aclock',examples:['aclock'],parse:only('aclock'),
   capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   apply(_step,frame){
    const data=new Uint8Array(frame.samples*2),view=new DataView(data.buffer),start=Number(frame.pts!.value*frame.pts!.timeBase.num*BigInt(frame.sampleRate)/frame.pts!.timeBase.den);
    for(let index=0;index<frame.samples;index++)view.setInt16(index*2,start+index,true);
    return {...frame,planes:[data]};
   },
   reserve:()=>frameReservation}),
  // A tail filter that forgot count(): its generated packets would be cut silently on the PCM path.
  atail:defineAudioFilter({name:'atail',examples:['atail'],parse:only('atail'),
   capabilities:()=>({generatesOutput:true,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   async *stream(_step,frames){yield* frames;},reserve:()=>frameReservation}),
  // A planar-only step declared in the pre-registry string vocabulary, which only adelay, aformat and volume may use.
  aplanar:defineAudioFilter({name:'aplanar',examples:['aplanar'],parse:only('aplanar'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:true,timeSelection:false}),
   formats:()=>'planar',apply:(_step,frame,target,options)=>convertAudioFrame(frame,target,options),reserve:()=>frameReservation}),
  // aecho's native list on a stream step that converts to its negotiated format; declares rate conversion, which a native list cannot keep.
  alisted:defineAudioFilter({name:'alisted',examples:['alisted'],parse:only('alisted'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:true,timeSelection:false}),
   formats:()=>['s16p','s32p','fltp','dblp'],
   async *stream(_step,frames,options,_configured,negotiated){for await(const frame of frames){const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as AudioSampleFormat),options);worked.push(output.sampleFormat);yield output;}},
   reserve:()=>frameReservation}),
  // crystalizer's native list (packed and planar float): the encoder format can merge into it.
  apacked:defineAudioFilter({name:'apacked',examples:['apacked'],parse:only('apacked'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   formats:()=>['flt','fltp','dbl','dblp'],apply:(_step,frame,target,options)=>convertAudioFrame(frame,target,options),reserve:()=>frameReservation}),
  // A pinned format with a stereo, 44100 Hz constraint that native would satisfy by converting implicitly.
  astereo:defineAudioFilter({name:'astereo',examples:['astereo'],parse:only('astereo'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   formats:()=>['flt'],
   constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo'||format.sampleRate!==44100)throw new AudioFilterError('astereo requires stereo 44100 Hz input');},
   apply:(_step,frame,target,options)=>convertAudioFrame(frame,target,options),reserve:()=>frameReservation}),
  // Records the layout name its constraint sees, then refuses.
  alayout:defineAudioFilter({name:'alayout',examples:['alayout'],parse:only('alayout'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:false,formatConstraint:false,rateConversion:false,timeSelection:false}),
   constraint:()=>format=>{throw new AudioFilterError(`alayout saw ${format.channelLayout}`);},apply:(_step,frame)=>frame}),
  // A channel-preserving remap (channelmap=1|0): ff_planar_sample_fmts, an owned plane permutation, transparent because it only copies samples.
  aswap:defineAudioFilter({name:'aswap',examples:['aswap'],parse:only('aswap'),
   capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
   formats:()=>['u8p','s16p','s32p','fltp','dblp','s64p'],transparent:true,
   constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError('aswap requires a stereo layout');},
   apply(_step,frame,target,options){const planar=convertAudioFrame(frame,target,options);return {...planar,planes:[planar.planes[1]!,planar.planes[0]!]};},
   reserve:()=>frameReservation})
 };
});

// Raw s16 mono samples 1..400.
const input=new Uint8Array(800),view=new DataView(input.buffer);for(let index=0;index<400;index++)view.setInt16(index*2,index+1,true);
async function run(args:readonly string[],budget?:ResourceBudget,declared:readonly string[]=['-f','s16le','-ar','8000','-ac','1']){
 const sink=collectingOutput();let opens=0;
 const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;return sink.output;}};
 const result=await new FFmpeg({filesystem,backend:createMediaBackend(),...(budget?{budget}:{})}).exec([...declared,'-i','/in.raw',...args,...(args.includes('-f')?[]:['-f','s16le']),'/out.raw']);
 return {result,opens,bytes:sink.bytes()};
}
const samples=(bytes:Uint8Array)=>Array.from({length:bytes.length/2},(_,index)=>new DataView(bytes.buffer,bytes.byteOffset).getInt16(index*2,true));

describe('a filter added only through the registry',()=>{
 it('selects output time after a stream-only filter even when it declares no reframing',async()=>{
  const chain=compileAudioFilterChain('aprev');
  expect([chain.reframes,chain.capabilities[0]!.reframes,chain.capabilities[0]!.stateless]).toEqual([true,true,false]);
  const full=await run(['-af','aprev']);expect(full.result.exitCode,JSON.stringify(full.result.diagnostics)).toBe(0);
  expect(samples(full.bytes).slice(0,3)).toEqual([0,1,2]);expect(samples(full.bytes)[80]).toBe(80);
  // Output -ss 0.01 is 80 samples at 8000 Hz: filtering must still start from the input start.
  const seeked=await run(['-af','aprev','-ss','0.01']);expect(seeked.result.exitCode,JSON.stringify(seeked.result.diagnostics)).toBe(0);
  expect(seeked.bytes).toEqual(full.bytes.subarray(160));
 });
 it('selects output time after a timestamp-dependent stateless filter that declares reframing',async()=>{
  const full=await run(['-af','aclock']);expect(full.result.exitCode,JSON.stringify(full.result.diagnostics)).toBe(0);expect(samples(full.bytes).slice(0,3)).toEqual([0,1,2]);
  const seeked=await run(['-af','aclock','-ss','0.01']);expect(seeked.result.exitCode,JSON.stringify(seeked.result.diagnostics)).toBe(0);
  expect(samples(seeked.bytes).slice(0,2)).toEqual([80,81]);expect(seeked.bytes).toEqual(full.bytes.subarray(160));
 });
 it('reserves state declared only in reserve() on the PCM path before opening output',async()=>{
  const chain=compileAudioFilterChain('ahist'),plan={configuredInput:true,channels:1,samples:400n};
  expect(pcmFilterMemory(chain,{sampleRate:8000,channels:1,sampleFormat:'s16'},plan,{width:2,maxBufferBytes:4096,maxResidentBytes:1<<20})).toEqual({volumeNodes:0,stateBytes:3000});
  // State held inside the step's own count() slots adds nothing (aprev keeps 2 bytes in its 1-sample buffer slots).
  expect(pcmFilterMemory(compileAudioFilterChain('aprev'),{sampleRate:8000,channels:1,sampleFormat:'s16'},plan,{width:2,maxBufferBytes:4096,maxResidentBytes:1<<20})).toEqual({volumeNodes:1,stateBytes:0});
  expect(()=>pcmFilterMemory(chain,{sampleRate:8000,channels:1,sampleFormat:'s16'},plan,{width:2,maxBufferBytes:2999,maxResidentBytes:1<<20})).toThrow(/^Audio filter state exceeds the configured buffer budget$/);
  const budget={maxResidentBytes:7000,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:2};
  const refused=await run(['-af','ahist'],budget);
  expect(refused.result.exitCode).not.toBe(0);expect(refused.result.diagnostics[0]).toMatchObject({code:'resource-budget',message:'Audio filter state and one payload buffer exceed the resident-byte budget'});expect(refused.opens).toBe(0);
  // The same budget without the declared state plans and runs.
  const plain=await run(['-af','anull'],budget);expect(plain.result.exitCode,JSON.stringify(plain.result.diagnostics)).toBe(0);
  const accepted=await run(['-af','ahist'],{...budget,maxResidentBytes:budget.maxResidentBytes+3000});expect(accepted.result.exitCode,JSON.stringify(accepted.result.diagnostics)).toBe(0);expect(accepted.bytes).toEqual(plain.bytes);
 });
 it('refuses its unproven rate conversion and FLAC time selection without consumer edits',async()=>{
  const resampled=await run(['-af','aprev','-ar','16000']);
  expect(resampled.result.exitCode).not.toBe(0);expect(resampled.result.diagnostics[0]?.message).toBe('aprev with sample rate conversion is not implemented');expect(resampled.opens).toBe(0);
  expect(()=>compileFlacTransform(parseArgv(['-i','/in.flac','-t','0.002','-af','aprev','/out.pcm']),{format:'s16le',codec:'pcm_s16le'})).toThrow(/additional Native packet scheduling/);
  // Untimed FLAC input is refused too until a filter declares flacInput; the pre-registry neighbours keep running.
  expect(()=>compileFlacTransform(parseArgv(['-i','/in.flac','-af','volume=0.5,aprev','/out.pcm']),{format:'s16le',codec:'pcm_s16le'})).toThrow(/^FLAC input to aprev requires additional Native evidence$/);
  expect(compileFlacTransform(parseArgv(['-i','/in.flac','-af','volume=0.5,adelay=2S','/out.pcm']),{format:'s16le',codec:'pcm_s16le'})?.filters?.steps.map(step=>step.name)).toEqual(['volume','adelay']);
  expect([audioFilterCapabilities(compileAudioFilterChain('aprev').steps[0]!).flacInput,audioFilterCapabilities(compileAudioFilterChain('adelay').steps[0]!).flacInput]).toEqual([false,true]);
 });
 it('rejects packet sections that disagree with the declared sample count',()=>{
  expect(compileAudioFilterChain('askew').outputSamples(4n,8000)).toBe(5n);
  expect(()=>compileAudioFilterChain('askew').packetSections(4n,4n,8000)).toThrow(/^askew packet sections disagree with its sample count$/);
 });
 it('refuses a string format set or an output tail without count() from a new filter when compiling',async()=>{
  // No merge model checks the pre-registry vocabulary, so a new planar-only filter must declare its native list; the chain never negotiates around it.
  for(const description of ['aplanar','volume=0.5:precision=fixed,aplanar','anull,aplanar,aformat=f=s16'])expect(()=>compileAudioFilterChain(description),description).toThrow(/^Invalid audio filter format set: aplanar$/);
  expect(()=>compileAudioFilterChain('anull,atail')).toThrow(/^Invalid audio filter declaration: atail generates output without count\(\)$/);
  for(const filter of ['aplanar','atail']){
   const refused=await run(['-af',filter]);expect(refused.result.exitCode,filter).not.toBe(0);expect(refused.result.diagnostics[0]?.code,filter).toBe('unsupported-filter');expect(refused.opens,filter).toBe(0);
  }
 });
 it('negotiates a native format list like native and hands stream steps their negotiated format',async()=>{
  const chain=compileAudioFilterChain('alisted',{outputSampleFormat:'s16'});
  // aecho's native picks (pinned build, -v debug): every input keeps its sample type in planar form, u8 widens to s16p.
  expect((['u8','s16','s32','flt','dbl'] as const).map(format=>chain.negotiatedSampleFormats(format)[0])).toEqual(['s16p','s16p','s32p','fltp','dblp']);
  expect([chain.nativeFormatLists,compileAudioFilterChain('volume=0.5,adelay').nativeFormatLists]).toEqual([true,false]);
  // Without a precision hook the widest listed format sizes the chain; rate conversion is refused whatever the descriptor declares.
  expect([chain.maxBytesPerSample,chain.outputSampleFormat,chain.capabilities[0]!.rateConversion,audioFilterCapabilities(chain.steps[0]!).rateConversion]).toEqual([8,null,false,false]);
  expect(()=>chain.rateBoundary('s16',8000,16000)).toThrow(/^alisted with sample rate conversion is not implemented$/);
  worked.length=0;
  const full=await run(['-af','alisted']);expect(full.result.exitCode,JSON.stringify(full.result.diagnostics)).toBe(0);
  expect(full.bytes).toEqual(input);expect(new Set(worked)).toEqual(new Set(['s16p']));
 });
 it('merges a native format list with its neighbours and the encoder as native does',()=>{
  // aecho,volume=0.5 runs aecho in fltp: volume's native {flt,fltp} merges into its list. The pre-registry volume keeps packed flt, the same sample type.
  expect(compileAudioFilterChain('alisted,volume=0.5',{outputSampleFormat:'s16'}).negotiatedSampleFormats('s16')).toEqual(['fltp','flt']);
  // crystalizer's list takes the encoder format when it can; a channel conversion after the chain blocks that merge.
  expect(compileAudioFilterChain('apacked',{outputSampleFormat:'dbl'}).negotiatedSampleFormats('s16')).toEqual(['dbl']);
  expect(compileAudioFilterChain('apacked',{outputSampleFormat:'flt',outputConversion:true}).negotiatedSampleFormats('u8')).toEqual(['flt']);
  expect(compileAudioFilterChain('apacked',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toEqual(['flt']);
  // adelay merges into the list's segment natively; it only copies samples, so its own planar format stays.
  expect(compileAudioFilterChain('adelay=2S,alisted').negotiatedSampleFormats('u8')).toEqual(['u8p','s16p']);
 });
 it('refuses negotiations it cannot reproduce before any output',async()=>{
  // Fixed volume on float input merges with aecho's list into {s16p,s32p} natively; the pre-registry rule would keep s16.
  expect(()=>compileAudioFilterChain('volume=0.5:precision=fixed,alisted',{outputSampleFormat:'s16'}).negotiatedSampleFormats('flt')).toThrow(/^alisted with flt input requires unimplemented format negotiation$/);
  // With an input trim the source format merges last, so apacked would run in dbl instead of flt: the chain cannot know, so it refuses.
  expect(()=>compileAudioFilterChain('apacked,aformat=f=dbl').negotiatedSampleFormats('flt')).toThrow(/^apacked with flt input requires unimplemented format negotiation$/);
  // ff_planar_sample_fmts ends with s64p, which native picks for double input (a tie with dblp goes to the later entry).
  expect(()=>compileAudioFilterChain('aswap').negotiatedSampleFormats('dbl')).toThrow(/^aswap with dbl input negotiates s64p, which is not implemented$/);
  const refused=await run(['-af','aswap','-f','f64le'],undefined,['-f','f64le','-ar','8000','-ac','2']);
  expect(refused.result.exitCode).not.toBe(0);expect(refused.result.diagnostics[0]?.message).toBe('aswap with dbl input negotiates s64p, which is not implemented');expect(refused.opens).toBe(0);
  const fixed=await run(['-af','volume=0.5:precision=fixed,alisted','-cpuflags','0','-f','s16le'],undefined,['-f','f32le','-ar','8000','-ac','1']);
  expect(fixed.result.diagnostics[0]?.message).toBe('alisted with flt input requires unimplemented format negotiation');expect(fixed.opens).toBe(0);
  const stereo=await run(['-af','alisted','-f','f64le'],undefined,['-f','f64le','-ar','8000','-ac','2']);expect(stereo.result.exitCode,JSON.stringify(stereo.result.diagnostics)).toBe(0);expect(stereo.bytes).toEqual(input);
  const doubled=await run(['-af','volume=0.5:precision=fixed,alisted','-cpuflags','0']);expect(doubled.result.exitCode,JSON.stringify(doubled.result.diagnostics)).toBe(0);
 });
 it('fails a stereo or fixed-rate constraint explicitly before opening output, and runs when it holds',async()=>{
  const frame=(channels:number,sampleRate:number):AudioFrameData=>({sampleRate,channels,channelLayout:channels===2?'stereo':'mono',sampleFormat:'s16',samples:2,planes:[new Uint8Array(4*channels)],pts:null});
  const chain=compileAudioFilterChain('astereo');
  expect(()=>chain.apply(frame(1,44100),{maxFrameBytes:64})).toThrow(/^astereo requires stereo 44100 Hz input$/);
  expect(()=>chain.validateInputFormat(frame(2,8000))).toThrow(/^astereo requires stereo 44100 Hz input$/);
  expect(chain.apply(frame(2,44100),{maxFrameBytes:64}).sampleFormat).toBe('flt');
  for(const declared of [['-f','s16le','-ar','44100','-ac','1'],['-f','s16le','-ar','8000','-ac','2']]){
   const refused=await run(['-af','astereo','-cpuflags','0'],undefined,declared);
   expect(refused.result.exitCode,declared.join(' ')).not.toBe(0);expect(refused.result.diagnostics[0]?.message).toBe('astereo requires stereo 44100 Hz input');expect(refused.opens).toBe(0);
  }
  const accepted=await run(['-af','astereo','-cpuflags','0'],undefined,['-f','s16le','-ar','44100','-ac','2']);expect(accepted.result.exitCode,JSON.stringify(accepted.result.diagnostics)).toBe(0);expect(accepted.bytes).toEqual(input);
 });
 it('runs a channel-preserving remap registered only through the registry',async()=>{
  const swapped=await run(['-af','aswap'],undefined,['-f','s16le','-ar','8000','-ac','2']);expect(swapped.result.exitCode,JSON.stringify(swapped.result.diagnostics)).toBe(0);
  const values=samples(input),expected=values.map((_,index)=>values[index^1]!);
  expect(samples(swapped.bytes)).toEqual(expected);
  const mono=await run(['-af','aswap']);expect(mono.result.diagnostics[0]?.message).toBe('aswap requires a stereo layout');expect(mono.opens).toBe(0);
 });
 it('sees a non-default WAV channel mask in constraint() and refuses it before opening output',async()=>{
  const seen:string[]=[];
  for(const mask of [0x3,0x5,0x60000000,null]){
   const wav=extensibleWav(2,mask);let opens=0;
   const filesystem:VirtualFileSystem={async openRead(){return {size:BigInt(wav.length),async readAt(offset,length){return wav.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;return collectingOutput().output;}};
   const exec=(filter:string)=>new FFmpeg({filesystem,backend:createMediaBackend()}).exec(['-i','/in.wav','-af',filter,'-cpuflags','0','-f','s16le','/out.raw']);
   for(const filter of ['astereo','aswap','aformat=cl=stereo','alayout']){
    opens=0;const result=await exec(filter);
    if(filter==='alayout'){seen.push(String(result.diagnostics[0]?.message));continue;}
    if(mask===0x3||mask===null){expect(result.exitCode,`${filter} ${mask} ${JSON.stringify(result.diagnostics)}`).toBe(0);continue;}
    // Only the layout name changed: each check refuses exactly as it refuses a mono input, with nothing opened.
    expect(result.exitCode,`${filter} ${mask}`).not.toBe(0);expect(opens,`${filter} ${mask}`).toBe(0);
    expect(result.diagnostics[0]?.message,`${filter} ${mask}`).toBe({astereo:'astereo requires stereo 44100 Hz input',aswap:'aswap requires a stereo layout','aformat=cl=stereo':'aformat channel layout constraint requires an implicit conversion'}[filter]);
   }
  }
  expect(seen).toEqual(['alayout saw stereo','alayout saw 2 channels (FL+FC)','alayout saw downmix','alayout saw stereo']);
 });
});
/** 2-channel s16 44100 Hz WAV: WAVEFORMATEXTENSIBLE with `mask`, or plain WAVEFORMATEX for null. */
function extensibleWav(channels:number,mask:number|null):Uint8Array{
 const fmt=mask===null?16:40,data=input.length,bytes=new Uint8Array(28+fmt+data),out=new DataView(bytes.buffer),text=(at:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[at+index]=value.charCodeAt(index);};
 text(0,'RIFF');out.setUint32(4,20+fmt+data,true);text(8,'WAVE');text(12,'fmt ');out.setUint32(16,fmt,true);
 out.setUint16(20,mask===null?1:0xfffe,true);out.setUint16(22,channels,true);out.setUint32(24,44100,true);out.setUint32(28,44100*channels*2,true);out.setUint16(32,channels*2,true);out.setUint16(34,16,true);
 if(mask!==null){out.setUint16(36,22,true);out.setUint16(38,16,true);out.setUint32(40,mask>>>0,true);bytes.set([1,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],44);}
 text(20+fmt,'data');out.setUint32(24+fmt,data,true);bytes.set(input,28+fmt);
 return bytes;
}
