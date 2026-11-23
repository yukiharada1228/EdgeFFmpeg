import {expect,it} from 'vitest';
import {audioCheckpointPipelinePatches,createAudioCheckpointPipeline,deserializeAudioCheckpointPipeline,inspectAudioCheckpointPipeline,serializeAudioCheckpointPipeline,validateAudioCheckpointPipelineConfig,AudioCheckpointPipelineError} from '@edge-ffmpeg/avformat';
import type {AudioCheckpointPipelineConfig,AudioCheckpointPipelinePosition,AudioCheckpointPipelineStage} from '@edge-ffmpeg/avformat';
import {createAudioReframeState,padAudio,reframeAudio,serializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import {convertAudioFrame,resampleAudio,serializeAudioResampleCheckpoint} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat,ResampleSampleFormat} from '@edge-ffmpeg/swresample';
import {createWavMuxState,muxWav,openWav,serializeWavMuxState,wavMuxPatches,WavError} from '@edge-ffmpeg/containers';
import type {WavPcmCodec} from '@edge-ffmpeg/containers';
import {decodePcm,encodePcm} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData,PcmCodec} from '@edge-ffmpeg/avutil';
import {collectingOutput} from '../helpers/output.js';
import {chunk,memoryInput,pcmFormat,riff} from '../helpers/wav.js';
type Codec='pcm_s16le'|'pcm_f32le'|'pcm_f64le';
const formats={pcm_s16le:'s16',pcm_f32le:'flt',pcm_f64le:'dbl'} as const,profile='ffmpeg-9.0.2' as const;
const limits={maxFrameBytes:4096,maxStateBytes:1<<20,maxReadBytes:2048,maxUnitBytes:65536,maxUnits:256};
const fifo=(samples:number,pad:boolean):AudioCheckpointPipelineStage=>({filter:'asetnsamples',samples,pad});
const apad=(mode:'pad_len'|'whole_len'|'pad_dur'|'whole_dur',limit:string,packetSamples=5,packetsPerUnit=2):AudioCheckpointPipelineStage=>({filter:'apad',mode,limit,packetSamples,packetsPerUnit});
const config=(overrides:Partial<AudioCheckpointPipelineConfig>={}):AudioCheckpointPipelineConfig=>({outputRate:11025,precision:'s16',codec:'pcm_s16le',bitexact:false,stage:fifo(7,true),unitSamples:13,limits,...overrides});
const omit=(value:object,key:string)=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,part)=>size+part.length,0));let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}return bytes;};
const patched=(bytes:Uint8Array,patches:readonly {offset:bigint;bytes:Uint8Array}[])=>{const result=bytes.slice();for(const entry of patches)result.set(entry.bytes,Number(entry.offset));return result;};
/** Deterministic interleaved PCM in a native-written (bitexact) WAV container. */
async function wav(codec:WavPcmCodec,channels:number,samples:number,rate:number,channelMask?:number):Promise<Uint8Array>{
 const width=codec==='pcm_u8'?1:codec==='pcm_s16le'?2:codec==='pcm_f32le'?4:8,data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);
 for(let i=0;i<samples*channels;i++){const value=.6*Math.sin(i*.0731)+.3*Math.cos(i*.53);if(width===1)view.setUint8(i,(i*37+5)&255);else if(width===2)view.setInt16(i*2,((i*3137+911)%65536)-32768,true);else if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
 const sink=collectingOutput();async function* packets(){if(samples)yield {streamIndex:0,data,pts:0n,dts:0n,duration:BigInt(samples),timeBase:{num:1n,den:BigInt(rate)},flags:1};}
 await muxWav(sink.output,{codec,channels,sampleRate:rate,...(channelMask===undefined?{}:{channelMask})},packets(),{sampleCount:BigInt(samples),maxWriteBytes:4096,metadataProfile:profile,bitexact:true});return sink.bytes();
}
const next=(position:AudioCheckpointPipelinePosition,unit:{output:Uint8Array|null;inputPosition:string})=>({revision:position.revision+1,inputPosition:unit.inputPosition,outputPosition:String(BigInt(position.outputPosition)+BigInt(unit.output?.length??0))});
/** Unit loop as the runner drives it; `restore` moves the serialized state into a fresh component (a new Worker) at every boundary. */
async function drive(c:AudioCheckpointPipelineConfig,file:Uint8Array,restore:boolean){
 const make=()=>createAudioCheckpointPipeline(c,memoryInput(file));let component=make(),state=await component.create(),position:AudioCheckpointPipelinePosition={revision:0,inputPosition:'0',outputPosition:'0'};
 expect(component.verify(state,position)).toBe(true);const units:Uint8Array[]=[],snapshots:Uint8Array[]=[];
 for(;;){
  const unit=await component.process(state,position,undefined);position=next(position,unit);units.push(unit.output??new Uint8Array());
  expect(component.verify(state,position)).toBe(true);expect(component.verify(state,{...position,outputPosition:String(BigInt(position.outputPosition)+1n)})).toBe(false);expect(component.verify(state,{...position,inputPosition:String(BigInt(position.inputPosition)+1n)})).toBe(false);
  const saved=component.serialize(state);snapshots.push(saved);
  // Every snapshot has exactly one encoding.
  expect(serializeAudioCheckpointPipeline(deserializeAudioCheckpointPipeline(saved,c),c)).toEqual(saved);
  if(restore){component.dispose(state);component=make();state=await component.restore(saved,position);expect(component.verify(state,position)).toBe(true);expect(component.serialize(state)).toEqual(saved);}
  if(unit.finished)break;
 }
 component.dispose(state);const raw=concat(units);
 return {units,snapshots,position,raw,output:patched(raw,audioCheckpointPipelinePatches(snapshots.at(-1)!,BigInt(raw.length),c))};
}
/** Independent finite composition of the same library components: resampleAudio, reframeAudio/padAudio and muxWav.
 * Without a rate change native's full_convert ignores tsf, so the input converts straight to the output format. */
async function finite(c:AudioCheckpointPipelineConfig,file:Uint8Array):Promise<Uint8Array>{
 const input=await openWav(memoryInput(file),{maxReadBytes:1<<20}),info=input.info,plan=await inspectAudioCheckpointPipeline(c,memoryInput(file)),options={maxFrameBytes:1<<20},out=formats[c.codec],work=info.sampleRate===c.outputRate?out:c.precision;
 async function* frames(){for await(const packet of input.packets(0n,info.blockAlign*64)){const frame=decodePcm(packet,{codec:info.codec as PcmCodec,channels:info.channels,sampleRate:info.sampleRate},options);yield frame.sampleFormat===work?frame:convertAudioFrame(frame,work as AudioSampleFormat,options);}}
 async function* converted(){for await(const frame of resampleAudio(frames(),c.outputRate,{maxFrameBytes:1<<16,maxStateBytes:1<<22,sampleFormat:work}))yield frame.sampleFormat===out?frame:convertAudioFrame(frame,out,options);}
 const stage=c.stage,limit=stage.filter==='apad'?BigInt(stage.limit):0n;
 const staged:AsyncIterable<AudioFrameData>=stage.filter==='asetnsamples'?reframeAudio(converted(),stage.samples,stage.pad,options):padAudio(converted(),{...options,packetSamples:stage.packetSamples,emptyInput:{sampleRate:c.outputRate,channels:info.channels,channelLayout:'any',sampleFormat:out,pts:{value:0n,timeBase:{num:1n,den:BigInt(c.outputRate)}}},...(stage.mode==='pad_len'?{padSamples:limit}:stage.mode==='whole_len'?{wholeSamples:limit}:stage.mode==='pad_dur'?{padDurationMicros:limit}:{wholeDurationMicros:limit})});
 async function* packets(){for await(const frame of staged)yield encodePcm(frame,c.codec,options);}
 const sink=collectingOutput();await muxWav(sink.output,{codec:c.codec,channels:info.channels,sampleRate:c.outputRate,channelMask:BigInt(plan.input.channelMask)},packets(),{sampleCount:plan.outputSamples,maxWriteBytes:4096,metadataProfile:profile,bitexact:c.bitexact});return sink.bytes();
}
it('validates and canonicalizes the configuration, rejecting unknown, missing and unsupported fields and stages',()=>{
 const reordered={limits:{maxUnits:256,maxUnitBytes:65536,maxReadBytes:2048,maxStateBytes:1<<20,maxFrameBytes:4096},unitSamples:13,stage:{pad:true,samples:7,filter:'asetnsamples'},bitexact:false,codec:'pcm_s16le',precision:'s16',outputRate:11025} as unknown as AudioCheckpointPipelineConfig;
 const canonical=validateAudioCheckpointPipelineConfig(reordered);expect(JSON.stringify(canonical)).toBe(JSON.stringify(config()));expect(Object.isFrozen(canonical)&&Object.isFrozen(canonical.stage)&&Object.isFrozen(canonical.limits)).toBe(true);
 expect(validateAudioCheckpointPipelineConfig(config({stage:apad('whole_dur','9223372036854775807',4096,4096)})).stage).toEqual(apad('whole_dur','9223372036854775807',4096,4096));
 const bad:unknown[]=[
  {...config(),extra:1},{...config(),limits:{...limits,extra:1}},{...config(),stage:{...fifo(7,true),mode:'pad_len'}},omit(config(),'unitSamples'),{...config(),limits:omit(limits,'maxUnits')},
  config({outputRate:0}),config({outputRate:8000.5}),config({outputRate:2147483648}),config({precision:'s32' as ResampleSampleFormat}),config({codec:'pcm_u8' as Codec}),config({bitexact:1 as unknown as boolean}),config({unitSamples:0}),config({unitSamples:1048577}),
  config({limits:{...limits,maxFrameBytes:1}}),config({limits:{...limits,maxStateBytes:0}}),config({limits:{...limits,maxReadBytes:67108865}}),config({limits:{...limits,maxUnitBytes:0}}),config({limits:{...limits,maxUnits:65537}}),
  config({stage:{filter:'anull'} as unknown as AudioCheckpointPipelineStage}),config({stage:fifo(0,true)}),config({stage:{filter:'asetnsamples',samples:7,pad:1} as unknown as AudioCheckpointPipelineStage}),
  config({stage:apad('pad_frames' as 'pad_len','5')}),config({stage:apad('pad_len','05')}),config({stage:apad('pad_len','-1')}),config({stage:apad('pad_len','9223372036854775808')}),config({stage:apad('pad_len','5',0)}),config({stage:apad('pad_len','5',5,0)}),config({stage:apad('pad_len','5',5,4097)}),null,
 ];
 for(const value of bad)expect(()=>validateAudioCheckpointPipelineConfig(value as AudioCheckpointPipelineConfig),JSON.stringify(value)).toThrow(AudioCheckpointPipelineError);
 // Exactly one asetnsamples or apad stage; there is no stage list or pass-through.
 expect(()=>createAudioCheckpointPipeline(config({stage:[fifo(7,true),apad('pad_len','5')] as unknown as AudioCheckpointPipelineStage}),memoryInput(new Uint8Array(64)))).toThrow(/exactly one asetnsamples or apad stage/);
});
it('checks every static limit when the input header is read, before any child state or sample read',async()=>{
 const stereo=await wav('pcm_s16le',2,300,8000),requests:{offset:bigint;length:number}[]=[],plan=await inspectAudioCheckpointPipeline(config(),memoryInput(stereo,requests));
 expect(plan).toMatchObject({input:{codec:'pcm_s16le',channels:2,sampleRate:8000,channelMask:'3',dataOffset:'44',samples:'300'},frameSamples:1024,units:24});
 expect(requests.every(request=>request.offset<44n)).toBe(true);
 const cases:[string,Uint8Array|Promise<Uint8Array>,AudioCheckpointPipelineConfig,RegExp|typeof WavError][]=[
  ['empty',wav('pcm_s16le',2,0,8000),config(),/Empty audio checkpoint pipeline input/],
  ['u8',wav('pcm_u8',1,40,8000),config(),/Unsupported audio checkpoint pipeline input codec: pcm_u8/],
  ['no layout',riff([chunk('fmt ',pcmFormat(9,8000,16)),chunk('data',new Uint8Array(9*2*4))]),config(),/needs a channel mask or a default channel layout/],
  ['frame',stereo,config({unitSamples:13,limits:{...limits,maxFrameBytes:51}}),/unit exceeds maxFrameBytes/],
  ['read',stereo,config({limits:{...limits,maxReadBytes:51}}),/unit exceeds maxReadBytes/],
  ['state',stereo,config({limits:{...limits,maxStateBytes:64}}),/Resampling state exceeds allocation limit/],
  ['fifo',stereo,config({stage:fifo(1025,true)}),/asetnsamples frame exceeds maxFrameBytes/],
  ['apad',stereo,config({stage:apad('pad_len','2000',1025)}),/apad packet exceeds maxFrameBytes/],
  ['units',stereo,config({limits:{...limits,maxUnits:23}}),/needs more than maxUnits units/],
  ['drain units',stereo,config({stage:apad('pad_len','1000',5,2),limits:{...limits,maxUnits:122}}),/needs more than maxUnits units/],
  ['unit bytes',stereo,config({limits:{...limits,maxUnitBytes:plan.unitBytes-1}}),/unit output bound exceeds maxUnitBytes/],
  ['rf64',stereo,config({stage:apad('pad_len','1073741824'),limits:{...limits,maxUnits:65536}}),WavError],
 ];
 for(const [name,source,value,error]of cases){const bytes=await source,seen:{offset:bigint;length:number}[]=[],dataOffset=name==='empty'||name==='u8'?BigInt(bytes.length):44n;await expect(inspectAudioCheckpointPipeline(value,memoryInput(bytes,seen)),name).rejects.toThrow(error);await expect(createAudioCheckpointPipeline(value,memoryInput(bytes,seen)).create(),name).rejects.toThrow(error);expect(seen.every(request=>request.offset<dataOffset),name).toBe(true);}
 // The exact bound is accepted; the drain-unit count includes apad packets beyond the last input unit.
 expect((await inspectAudioCheckpointPipeline(config({limits:{...limits,maxUnitBytes:plan.unitBytes}}),memoryInput(stereo))).units).toBe(24);
 expect((await inspectAudioCheckpointPipeline(config({stage:apad('pad_len','1000',5,2)}),memoryInput(stereo))).units).toBe(23+100);
});
it('continues byte-identically across a serialized restore at every unit boundary, equals the finite component composition and stays within the static unit bound',async()=>{
 const profiles:[Codec,ResampleSampleFormat,Codec][]=[['pcm_s16le','s16','pcm_s16le'],['pcm_s16le','flt','pcm_s16le'],['pcm_f32le','flt','pcm_f32le'],['pcm_f64le','dbl','pcm_f64le'],['pcm_s16le','dbl','pcm_f32le'],['pcm_f32le','s16','pcm_f64le']];
 const stages=[fifo(7,true),fifo(5,false),apad('pad_len','37',4,2),apad('whole_len','400',16,1),apad('pad_dur','1500',8,3)];let checked=0;
 for(const [inputRate,outputRate]of [[8000,11025],[48000,8000],[44100,48001],[16000,16000]] as const)for(const channels of [1,3])for(const [input,precision,codec]of profiles)for(const [index,stage]of stages.entries())for(const samples of [1,20,173]){
  if((index+channels+samples)%3&&samples!==173)continue;
  const file=await wav(input,channels,samples,inputRate),c=config({outputRate,precision,codec,stage,unitSamples:6,bitexact:samples===20}),label=JSON.stringify([inputRate,outputRate,channels,input,precision,codec,stage,samples]);
  const plan=await inspectAudioCheckpointPipeline(c,memoryInput(file)),whole=await drive(c,file,false),resumed=await drive(c,file,true);
  expect(resumed.output,label).toEqual(whole.output);expect(resumed.snapshots,label).toEqual(whole.snapshots);expect(whole.output,label).toEqual(await finite(c,file));
  expect(whole.units.length,label).toBe(plan.units);expect(BigInt(whole.output.length),label).toBe(plan.outputBytes);expect(Math.max(...whole.units.map(unit=>unit.length)),label).toBeLessThanOrEqual(plan.unitBytes);expect(Math.max(...whole.snapshots.map(saved=>saved.length)),label).toBeLessThanOrEqual(plan.stateBytes);
  // Only the RIFF, fact and data size fields differ before final assembly; they hold native's pre-trailer placeholders.
  const terminal=deserializeAudioCheckpointPipeline(whole.snapshots.at(-1)!,c),offsets=new Set(wavMuxPatches(terminal.mux).flatMap(entry=>[0,1,2,3].map(at=>Number(entry.offset)+at)));
  for(let at=0;at<whole.raw.length;at++)if(whole.raw[at]!==whole.output[at])expect(offsets.has(at),label+' byte '+at).toBe(true);
  expect(new DataView(whole.raw.buffer).getUint32(4,true)).toBe(0xffffffff);checked++;
 }
 expect(checked).toBe(408);
},120000);
it('rejects non-canonical, inconsistent, truncated and mismatched snapshots',async()=>{
 const c=config({stage:apad('pad_len','40',4,2),limits:{...limits,maxFrameBytes:64}}),file=await wav('pcm_s16le',2,60,8000),{snapshots}=await drive(c,file,false),middle=snapshots[1]!,drain=snapshots.at(-2)!,terminal=snapshots.at(-1)!;
 expect(deserializeAudioCheckpointPipeline(drain,c).stage.checkpoint).toMatchObject({eof:true,finished:false});expect(deserializeAudioCheckpointPipeline(terminal,c).mux.finished).toBe(true);
 const length=new DataView(middle.buffer,middle.byteOffset).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(middle.subarray(4,4+length))) as Record<string,unknown>,tail=middle.subarray(4+length);
 const rebuild=(text:string,rest=tail)=>{const encoded=new TextEncoder().encode(text),bytes=new Uint8Array(4+encoded.length+rest.length);new DataView(bytes.buffer).setUint32(0,encoded.length,true);bytes.set(encoded,4);bytes.set(rest,4+encoded.length);return bytes;};
 expect(rebuild(JSON.stringify(header))).toEqual(middle);
 const noVersion=omit(header,'version'),variants=[JSON.stringify(header,null,1),JSON.stringify({kind:header.kind,...header}),JSON.stringify({...header,extra:1}),JSON.stringify(noVersion),JSON.stringify({...header,version:2}),JSON.stringify({...header,kind:'audio-pipeline'}),
  JSON.stringify({...header,parts:[...(header.parts as number[]).slice(0,2),(header.parts as number[])[2]!+1]}),JSON.stringify({...header,parts:(header.parts as number[]).slice(0,2)}),JSON.stringify({...header,input:{...header.input as object,samples:'20'}}),
  JSON.stringify({...header,input:{...header.input as object,channelMask:'7'}}),JSON.stringify({...header,config:{...header.config as object,unitSamples:12}}),'﻿'+JSON.stringify(header),JSON.stringify(header).replace('"version":1','"version":1.0'),JSON.stringify(header).replace('audio-checkpoint-pipeline','audio-checkpoint-pipelin\\u0065')];
 for(const text of variants)expect(()=>deserializeAudioCheckpointPipeline(rebuild(text),c),text.slice(0,60)).toThrow();
 for(let at=0;at<middle.length;at++)expect(()=>deserializeAudioCheckpointPipeline(middle.subarray(0,at),c)).toThrow();
 expect(()=>deserializeAudioCheckpointPipeline(concat([middle,new Uint8Array(1)]),c)).toThrow();
 expect(()=>deserializeAudioCheckpointPipeline(middle,{...c,unitSamples:12})).toThrow(/configuration mismatch/);expect(()=>deserializeAudioCheckpointPipeline(middle,{...c,limits:{...limits,maxStateBytes:64}})).toThrow();
 // Valid child encodings that do not chain: a resampler part from another boundary, a FIFO stage and a mux that wrote other samples.
 const decoded=deserializeAudioCheckpointPipeline(middle,c),other=deserializeAudioCheckpointPipeline(snapshots[3]!,c),parts=header.parts as [number,number,number];
 const swap=(index:number,part:Uint8Array)=>{const pieces=[tail.subarray(0,parts[0]),tail.subarray(parts[0],parts[0]+parts[1]),tail.subarray(parts[0]+parts[1])];pieces[index]=part;return rebuild(JSON.stringify({...header,parts:pieces.map(piece=>piece.length)}),concat(pieces));};
 expect(()=>deserializeAudioCheckpointPipeline(swap(0,serializeAudioResampleCheckpoint(other.resample,{maxFrameBytes:64,maxStateBytes:limits.maxStateBytes})),c)).toThrow(/disagrees with the pipeline/);
 // With one large pending frame two streaming resampler parts chain identically; only the journal position tells them apart.
 const wide=config({stage:apad('pad_len','40',4,2)}),early=(await drive(wide,file,false)).snapshots,component=createAudioCheckpointPipeline(wide,memoryInput(file)),swapped=await component.restore(early[3]!,{revision:2,inputPosition:'26',outputPosition:'0'});
 expect(component.verify(swapped,{revision:2,inputPosition:'26',outputPosition:String(swapped.bytes)})).toBe(false);expect(component.verify(swapped,{revision:4,inputPosition:'52',outputPosition:String(swapped.bytes)})).toBe(true);component.dispose(swapped);
 const reframe=createAudioReframeState(7,true,{maxFrameBytes:64});expect(()=>deserializeAudioCheckpointPipeline(swap(1,serializeAudioReframeCheckpoint(reframe.checkpoint(),{maxFrameBytes:64})),c)).toThrow();reframe.dispose();
 const mux=createWavMuxState({codec:'pcm_s16le',channels:2,sampleRate:11025,channelMask:3},{metadataProfile:profile});mux.start();mux.write({streamIndex:0,data:new Uint8Array(12),pts:0n,dts:0n,duration:3n,timeBase:{num:1n,den:11025n},flags:1});
 expect(()=>deserializeAudioCheckpointPipeline(swap(2,serializeWavMuxState(mux.snapshot())),c)).toThrow(/WAV mux state disagrees/);
 expect(()=>serializeAudioCheckpointPipeline({...decoded,mux:other.mux},c)).toThrow(/disagrees with the pipeline/);expect(()=>serializeAudioCheckpointPipeline({...decoded,stage:other.stage},c)).toThrow(/disagrees with the pipeline/);
 expect(()=>serializeAudioCheckpointPipeline({...decoded,input:{...decoded.input,samples:'20'}},c)).toThrow(/phase disagrees/);expect(()=>serializeAudioCheckpointPipeline({...decoded,config:{...c,bitexact:true}},c)).toThrow(/configuration mismatch/);
 expect(()=>serializeAudioCheckpointPipeline({...decoded,extra:1} as typeof decoded,c)).toThrow(/version or kind/);
 expect(()=>serializeAudioCheckpointPipeline({...decoded,stage:{filter:'asetnsamples',checkpoint:other.stage.checkpoint}} as typeof decoded,c)).toThrow(/version or kind/);expect(()=>serializeAudioCheckpointPipeline({...decoded,resample:null as never},c)).toThrow(/Invalid resampling checkpoint fields/);
 // A terminal mux with input left, and a streaming mux after the input ended, are not pipeline phases.
 const finishedMux=createWavMuxState({codec:'pcm_s16le',channels:2,sampleRate:11025,channelMask:3},{metadataProfile:profile},decoded.mux);finishedMux.finish();
 expect(()=>serializeAudioCheckpointPipeline({...decoded,mux:finishedMux.snapshot()},c)).toThrow(/phase disagrees/);
 const drained=deserializeAudioCheckpointPipeline(terminal,c);expect(()=>serializeAudioCheckpointPipeline({...drained,mux:{...drained.mux,finished:false,bytes:String(BigInt(drained.mux.bytes)-BigInt(Number(drained.mux.samples)*4&1))}},c)).toThrow(/phase disagrees/);
 // Restore re-reads the input header and refuses a different input than the snapshot names.
 await expect(createAudioCheckpointPipeline(c,memoryInput(await wav('pcm_s16le',2,61,8000))).restore(middle,{revision:2,inputPosition:'26',outputPosition:'0'})).rejects.toThrow(/input header changed/);
 await expect(createAudioCheckpointPipeline(c,memoryInput(await wav('pcm_s16le',2,60,16000))).restore(middle,{revision:2,inputPosition:'26',outputPosition:'0'})).rejects.toThrow(/input header changed/);
});
it('verifies child counters against journal positions and refuses poisoned, disposed or misplaced states',async()=>{
 const c=config(),file=await wav('pcm_s16le',2,60,8000),component=createAudioCheckpointPipeline(c,memoryInput(file)),state=await component.create(),zero={revision:0,inputPosition:'0',outputPosition:'0'};
 expect(component.verify(state,zero)).toBe(true);expect(component.verify(state,{...zero,revision:1})).toBe(false);expect(component.verify(state,{...zero,revision:-1})).toBe(false);expect(component.verify({} as typeof state,zero)).toBe(false);
 await expect(component.process(state,{revision:0,inputPosition:'13',outputPosition:'0'},undefined)).rejects.toThrow(/disagrees with the unit position/);
 // A failed unit poisons the in-memory state; the runner restores from the last committed one instead.
 expect(component.verify(state,zero)).toBe(false);expect(()=>component.serialize(state)).toThrow(/poisoned/);expect(()=>state.snapshot()).toThrow(/poisoned/);component.dispose(state);
 const fresh=await component.create(),unit=await component.process(fresh,zero,undefined),after=next(zero,unit);expect(unit).toMatchObject({inputPosition:'13',finished:false});
 expect(component.verify(fresh,after)).toBe(true);expect(component.verify(fresh,{...after,revision:0})).toBe(false);expect(fresh).toMatchObject({received:13n,bytes:BigInt(unit.output!.length),finished:false});
 const controller=new AbortController();controller.abort(Error('stop'));await expect(component.process(fresh,after,controller.signal)).rejects.toThrow('stop');expect(component.verify(fresh,after)).toBe(false);component.dispose(fresh);component.dispose(fresh);
 // Abort inside a unit: the ranged read observes it, then nothing else runs.
 const slow=memoryInput(file),reading={...slow,size:slow.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){if(offset>=44n){controller2.abort(Error('mid-unit'));}return slow.readAt(offset,length,signal);}},controller2=new AbortController();
 const late=createAudioCheckpointPipeline(c,reading),live=await late.create();await expect(late.process(live,zero,controller2.signal)).rejects.toThrow('mid-unit');expect(late.verify(live,zero)).toBe(false);late.dispose(live);
 const disposed=await component.create();component.dispose(disposed);expect(component.verify(disposed,zero)).toBe(false);await expect(component.process(disposed,zero,undefined)).rejects.toThrow(/disposed/);
});
it('derives the WAV trailer patches from the terminal state only',async()=>{
 const c=config({codec:'pcm_f32le',precision:'flt',stage:fifo(4,false)}),file=await wav('pcm_s16le',1,31,8000),{snapshots,raw}=await drive(c,file,true),terminal=snapshots.at(-1)!,decoded=deserializeAudioCheckpointPipeline(terminal,c);
 const patches=audioCheckpointPipelinePatches(terminal,BigInt(raw.length),c);expect(patches).toEqual(wavMuxPatches(decoded.mux));expect(patches.map(entry=>entry.offset)).toEqual([4n,BigInt(decoded.mux.layout.factOffset!),BigInt(decoded.mux.layout.dataSizeOffset)]);
 expect(()=>audioCheckpointPipelinePatches(terminal,BigInt(raw.length)+1n,c)).toThrow(/disagrees with the committed output/);expect(()=>audioCheckpointPipelinePatches(snapshots[0]!,BigInt(raw.length),c)).toThrow(/disagrees with the committed output/);
 expect(()=>audioCheckpointPipelinePatches(terminal,BigInt(raw.length),{...c,bitexact:true})).toThrow(/configuration mismatch/);
});
it('converts straight to the output format without a rate change, ignoring precision as native full_convert does',async()=>{
 // Each precision here is narrower than the input or output, so converting through it would quantize the samples.
 const profiles:[Codec,ResampleSampleFormat,Codec][]=[['pcm_f32le','s16','pcm_f32le'],['pcm_f64le','flt','pcm_f64le'],['pcm_f64le','s16','pcm_f64le'],['pcm_f32le','s16','pcm_f64le'],['pcm_f64le','flt','pcm_s16le'],['pcm_f64le','s16','pcm_f32le']],options={maxFrameBytes:1<<20};
 for(const [input,precision,codec]of profiles){
  const file=await wav(input,2,90,16000),c=config({outputRate:16000,precision,codec,stage:fifo(4,false),unitSamples:7}),{output,snapshots}=await drive(c,file,true),info=(await openWav(memoryInput(file),{maxReadBytes:4096})).info;
  const decoded=decodePcm({streamIndex:0,data:file.subarray(Number(info.dataOffset)),pts:0n,dts:0n,duration:90n,timeBase:{num:1n,den:16000n},flags:1},{codec:input,channels:2,sampleRate:16000},options);
  const direct=encodePcm(convertAudioFrame(decoded,formats[codec],options),codec,options).data;
  expect(output.subarray(deserializeAudioCheckpointPipeline(snapshots.at(-1)!,c).mux.layout.headerBytes),JSON.stringify([input,precision,codec])).toEqual(direct);
  if(input===codec)expect(direct).toEqual(file.subarray(Number(info.dataOffset)));
 }
});
it('rejects input WAV chunks the pipeline does not model and accepts the chunks native ignores, reading only chunk headers',async()=>{
 const text=(value:string)=>new TextEncoder().encode(value),fmt=chunk('fmt ',pcmFormat(2,8000,16)),data=chunk('data',new Uint8Array(60*4).map((_,at)=>at*37+11));
 const info=(...entries:[string,string][])=>chunk('LIST',concat([text('INFO'),...entries.map(([key,value])=>chunk(key,text(value+'\0')))]));
 const c=config(),plain=riff([fmt,data]),expected=(await drive(c,plain,false)).output;
 // The muxer always replaces or drops `encoder`, so an ISFT-only INFO list changes nothing; native skips unknown chunks.
 const accepted:[string,Uint8Array][]=[['ISFT',riff([fmt,info(['ISFT','Lavf62.3.100']),data])],['ISFT after data',riff([fmt,data,info(['ISFT','Other encoder'],['ISFT','x'])])],['JUNK and PEAK',riff([chunk('JUNK',new Uint8Array(28)),fmt,chunk('PEAK',new Uint8Array(24)),data])],['fact',riff([fmt,chunk('fact',new Uint8Array(4)),data])]];
 for(const [name,file]of accepted)expect((await drive(c,file,true)).output,name).toEqual(expected);
 const rejected:[string,Uint8Array,RegExp][]=[
  ['title',riff([fmt,info(['INAM','Hello']),data]),/metadata "INAM" is not implemented/],['encoder and artist',riff([fmt,info(['ISFT','Lavf'],['IART','Someone']),data]),/metadata "IART" is not implemented/],
  ['tags after data',riff([fmt,data,info(['ICMT','note'])]),/metadata "ICMT" is not implemented/],['lowercase list',riff([fmt,chunk('list',concat([text('INFO'),chunk('INAM',text('x\0'))])),data]),/metadata "INAM" is not implemented/],
  ['adtl',riff([fmt,chunk('LIST',concat([text('adtl'),chunk('labl',new Uint8Array(8))])),data]),/LIST chunk other than INFO/],['zero INFO key',riff([fmt,chunk('LIST',concat([text('INFO'),new Uint8Array(8)])),data]),/metadata "\\u0000/],
  ['short INFO entry',riff([fmt,chunk('LIST',concat([text('INFO'),new Uint8Array(4)])),data]),/Malformed audio checkpoint pipeline input INFO list/],['overlong INFO entry',riff([fmt,chunk('LIST',concat([text('INFOISFT'),new Uint8Array([200,0,0,0]),text('Lavf')])),data]),/Malformed audio checkpoint pipeline input INFO list/],
  ['bext',riff([fmt,chunk('bext',new Uint8Array(602)),data]),/"bext" chunk is not implemented/],['id3',riff([fmt,data,chunk('id3 ',new Uint8Array(10))]),/"id3 " chunk is not implemented/],['ID3',riff([fmt,data,chunk('ID3 ',new Uint8Array(10))]),/"ID3 " chunk is not implemented/],
  ['cue',riff([fmt,chunk('cue ',new Uint8Array(4)),data]),/"cue " chunk is not implemented/],['SMV0',riff([fmt,data,chunk('SMV0',new Uint8Array(4))]),/"SMV0" chunk is not implemented/],
  ['trailing chunk',concat([plain,info(['INAM','x'])]),/bytes after its RIFF chunk is not implemented/],
 ];
 for(const [name,file,error]of rejected){
  const {dataOffset,dataBytes}=(await openWav(memoryInput(file),{maxReadBytes:4096})).info,seen:{offset:bigint;length:number}[]=[];
  await expect(inspectAudioCheckpointPipeline(c,memoryInput(file,seen)),name).rejects.toThrow(error);await expect(createAudioCheckpointPipeline(c,memoryInput(file,seen)).create(),name).rejects.toThrow(error);
  expect(seen.every(request=>request.offset+BigInt(request.length)<=dataOffset||request.offset>=dataOffset+dataBytes),name).toBe(true);
 }
 // Restore re-scans: a committed state of the plain input does not resume against the same samples with tags appended.
 const {snapshots,position}=await drive(c,plain,false),tagged=rejected.find(([name])=>name==='tags after data')![1];
 await expect(createAudioCheckpointPipeline(c,memoryInput(tagged)).restore(snapshots[1]!,{...position,revision:2})).rejects.toThrow(/metadata "ICMT"/);
 // Chunk headers are read in maxReadBytes slices as well.
 const mono=config({unitSamples:1,limits:{...limits,maxReadBytes:3}}),monoFormat=chunk('fmt ',pcmFormat(1,8000,16)),slices:{offset:bigint;length:number}[]=[];
 expect((await inspectAudioCheckpointPipeline(mono,memoryInput(riff([monoFormat,info(['ISFT','Lavf']),data]),slices))).units).toBe(120);
 await expect(inspectAudioCheckpointPipeline(mono,memoryInput(riff([monoFormat,data,info(['ISFT','Lavf'],['INAM','x'])]),slices))).rejects.toThrow(/metadata "INAM"/);expect(slices.every(request=>request.length<=3)).toBe(true);
});
