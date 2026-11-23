import {defaultChannelLayout} from '@edge-ffmpeg/avutil';
import type {AudioFrameData,MediaPacket} from '@edge-ffmpeg/avutil';
import type {ReadHandle} from '@edge-ffmpeg/core';
import {decodePcm,encodePcm} from '@edge-ffmpeg/avcodec';
import {convertAudioFrame,createAudioResampleState,deserializeAudioResampleCheckpoint,planAudioResample,resampledSampleCount,serializeAudioResampleCheckpoint} from '@edge-ffmpeg/swresample';
import type {AudioResampleCheckpoint,AudioResampleState,ResampleSampleFormat} from '@edge-ffmpeg/swresample';
import {createAudioPadState,createAudioReframeState,deserializeAudioPadCheckpoint,deserializeAudioReframeCheckpoint,paddingDurationSamples,serializeAudioPadCheckpoint,serializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioPadCheckpoint,AudioPadMode,AudioPadOptions,AudioPadState,AudioReframeCheckpoint,AudioReframeState} from '@edge-ffmpeg/avfilter';
import {createWavMuxState,deserializeWavMuxState,openWav,serializeWavMuxState,validateWavOutput,wavMuxPatches} from '@edge-ffmpeg/containers';
import type {WavInfo,WavInput,WavMuxPatch,WavMuxSnapshot,WavMuxState,WavOutputFormat} from '@edge-ffmpeg/containers';
export class AudioCheckpointPipelineError extends Error {}
/** WAV PCM codecs accepted on both ends; each maps one-to-one onto a resampler precision. */
export type AudioCheckpointPipelineCodec='pcm_s16le'|'pcm_f32le'|'pcm_f64le';
/** The one stage between the resampler and the WAV mux: asetnsamples=n=<samples>:p=<pad>, or apad with one finite length. */
export type AudioCheckpointPipelineStage=
 {readonly filter:'asetnsamples';readonly samples:number;readonly pad:boolean}|
 /** `limit` is canonical decimal samples (`*_len`) or microseconds (`*_dur`); at most `packetsPerUnit` silence packets per unit. */
 {readonly filter:'apad';readonly mode:AudioPadMode;readonly limit:string;readonly packetSamples:number;readonly packetsPerUnit:number};
export interface AudioCheckpointPipelineLimits {
 /** Every frame (decoded, converted, resampled, reframed) and the FIFO/apad packet. */
 readonly maxFrameBytes:number;readonly maxStateBytes:number;
 /** Ranged input read size; one unit reads `unitSamples` sample frames in slices of at most this many bytes. */
 readonly maxReadBytes:number;
 /** Static upper bound on one unit's output, checked before any unit runs; set it at or below the journal object limit. */
 readonly maxUnitBytes:number;
 /** Units the input needs (input units plus apad drain units); set it at or below the journal revision budget (256). */
 readonly maxUnits:number;
}
/** JSON-only, so it can travel in a Workflow spec. Native equivalent:
 * `-cpuflags 0 -i in.wav -af aresample=<outputRate>:tsf=<precision>p,<stage> -c:a <codec> [-bitexact] out.wav`.
 * `precision` is the FIR precision. Without a rate change native's swr_init takes full_convert and ignores tsf, so the
 * input then converts straight to the output format and `precision` is unused. */
export interface AudioCheckpointPipelineConfig {
 readonly outputRate:number;readonly precision:ResampleSampleFormat;readonly codec:AudioCheckpointPipelineCodec;readonly bitexact:boolean;
 readonly stage:AudioCheckpointPipelineStage;readonly unitSamples:number;readonly limits:AudioCheckpointPipelineLimits;
}
/** Parsed input header bound into the snapshot; restore re-reads the header and rejects any difference. */
export interface AudioCheckpointPipelineInput {readonly codec:AudioCheckpointPipelineCodec;readonly channels:number;readonly sampleRate:number;readonly channelMask:string;readonly dataOffset:string;readonly samples:string}
export type AudioCheckpointPipelineStageCheckpoint={readonly filter:'asetnsamples';readonly checkpoint:AudioReframeCheckpoint}|{readonly filter:'apad';readonly checkpoint:AudioPadCheckpoint};
export interface AudioCheckpointPipelineSnapshot {
 readonly version:1;readonly kind:'audio-checkpoint-pipeline';readonly config:AudioCheckpointPipelineConfig;readonly input:AudioCheckpointPipelineInput;
 readonly resample:AudioResampleCheckpoint;readonly stage:AudioCheckpointPipelineStageCheckpoint;readonly mux:WavMuxSnapshot;
}
/** Journal head the runner compares against: input position in input sample frames, output position in bytes. */
export interface AudioCheckpointPipelinePosition {readonly revision:number;readonly inputPosition:string;readonly outputPosition:string}
export interface AudioCheckpointPipelineUnit {readonly output:Uint8Array|null;readonly inputPosition:string;readonly finished:boolean}
/** Opaque live state; only `snapshot()` and the counters are visible. */
export interface AudioCheckpointPipelineState {readonly received:bigint;readonly bytes:bigint;readonly finished:boolean;snapshot():AudioCheckpointPipelineSnapshot}
/** Structurally a runtime `MediaCheckpointComponent`: this package knows nothing of journals or R2. */
export interface AudioCheckpointPipeline {
 create():Promise<AudioCheckpointPipelineState>;restore(state:Uint8Array,position:AudioCheckpointPipelinePosition):Promise<AudioCheckpointPipelineState>;
 process(state:AudioCheckpointPipelineState,position:AudioCheckpointPipelinePosition,signal:AbortSignal|undefined):Promise<AudioCheckpointPipelineUnit>;
 serialize(state:AudioCheckpointPipelineState):Uint8Array;verify(state:AudioCheckpointPipelineState,position:AudioCheckpointPipelinePosition):boolean;dispose(state:AudioCheckpointPipelineState):void;
}
const codecs:Readonly<Record<AudioCheckpointPipelineCodec,ResampleSampleFormat>>={pcm_s16le:'s16',pcm_f32le:'flt',pcm_f64le:'dbl'},widths:Readonly<Record<ResampleSampleFormat,number>>={s16:2,flt:4,dbl:8};
const precisions:readonly string[]=['s16','flt','dbl'],modes:readonly string[]=['pad_len','whole_len','pad_dur','whole_dur'],profile='ffmpeg-9.0.2' as const,MAX=(1n<<63n)-1n,maxHeaderBytes=16384;
const fields=['version','kind','config','input','parts'],configFields=['outputRate','precision','codec','bitexact','stage','unitSamples','limits'],limitFields=['maxFrameBytes','maxStateBytes','maxReadBytes','maxUnitBytes','maxUnits'];
const fifoFields=['filter','samples','pad'],padFields=['filter','mode','limit','packetSamples','packetsPerUnit'],inputFields=['codec','channels','sampleRate','channelMask','dataOffset','samples'];
function invalid(message:string):never{throw new AudioCheckpointPipelineError(message);}
const integer=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const exact=(value:unknown,names:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function decimal(value:unknown,message:string):bigint{if(typeof value!=='string'||value.length>20||!/^(?:0|[1-9][0-9]*)$/.test(value))invalid(message);const result=BigInt(value);if(result>MAX)invalid(message);return result;}
const ceil=(numerator:bigint,denominator:bigint)=>(numerator+denominator-1n)/denominator;
/** Canonical, frozen copy with fixed key order; unknown or missing keys are rejected at every level. */
export function validateAudioCheckpointPipelineConfig(config:AudioCheckpointPipelineConfig):AudioCheckpointPipelineConfig{
 if(!exact(config,configFields)||!exact(config.limits,limitFields)||!config.stage||typeof config.stage!=='object')invalid('Unknown or missing audio checkpoint pipeline configuration fields');
 const {outputRate,precision,codec,bitexact,stage,unitSamples,limits}=config,{maxFrameBytes,maxStateBytes,maxReadBytes,maxUnitBytes,maxUnits}=limits;
 if(!integer(outputRate,1,2147483647)||!precisions.includes(precision)||typeof codec!=='string'||!Object.hasOwn(codecs,codec)||typeof bitexact!=='boolean'||!integer(unitSamples,1,1048576))invalid('Invalid audio checkpoint pipeline configuration');
 if(!integer(maxFrameBytes,2,67108864)||!integer(maxStateBytes,1,67108864)||!integer(maxReadBytes,1,67108864)||!integer(maxUnitBytes,1,67108864)||!integer(maxUnits,1,65536))invalid('Invalid audio checkpoint pipeline limits');
 let captured:AudioCheckpointPipelineStage;
 if(stage.filter==='asetnsamples'){if(!exact(stage,fifoFields)||!integer(stage.samples,1,2147483647)||typeof stage.pad!=='boolean')invalid('Invalid audio checkpoint pipeline asetnsamples stage');captured={filter:'asetnsamples',samples:stage.samples,pad:stage.pad};}
 else if(stage.filter==='apad'){if(!exact(stage,padFields)||!modes.includes(stage.mode)||!integer(stage.packetSamples,1,2147483647)||!integer(stage.packetsPerUnit,1,4096))invalid('Invalid audio checkpoint pipeline apad stage');decimal(stage.limit,'Invalid audio checkpoint pipeline apad length');captured={filter:'apad',mode:stage.mode,limit:stage.limit,packetSamples:stage.packetSamples,packetsPerUnit:stage.packetsPerUnit};}
 else invalid('Unsupported audio checkpoint pipeline stage; exactly one asetnsamples or apad stage is implemented');
 return Object.freeze({outputRate,precision,codec,bitexact,stage:Object.freeze(captured),unitSamples,limits:Object.freeze({maxFrameBytes,maxStateBytes,maxReadBytes,maxUnitBytes,maxUnits})});
}
/** The effective output mask follows the CLI: the input's mask, else the default layout of its channel count. */
function inputOf(info:WavInfo):AudioCheckpointPipelineInput{
 if(!Object.hasOwn(codecs,info.codec))invalid('Unsupported audio checkpoint pipeline input codec: '+info.codec);
 const mask=info.channelMask!==null?BigInt(info.channelMask):defaultChannelLayout(info.channels)?.mask??null;
 if(mask===null)invalid('Audio checkpoint pipeline input needs a channel mask or a default channel layout');
 return Object.freeze({codec:info.codec as AudioCheckpointPipelineCodec,channels:info.channels,sampleRate:info.sampleRate,channelMask:mask.toString(),dataOffset:info.dataOffset.toString(),samples:info.durationSamples.toString()});
}
/** Chunks native's WAV demuxer turns into metadata, chapters or extra streams (wavdec.c read_header); every other chunk it skips. */
const carried:readonly string[]=['bext','ID3 ','id3 ','cue ','SMV0','XMA2'];
/** openWav skips every chunk but `fmt ` and `data`, while `-i in.wav` copies LIST/INFO, bext and ID3 tags into the output's INFO
 * list. Such chunks are rejected, except a LIST/INFO whose entries are all ISFT: the muxer always replaces or drops `encoder`.
 * Native also parses chunks past the RIFF size, so trailing bytes are rejected. Reads chunk headers only, in maxReadBytes slices. */
async function untagged(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<void>{
 const read=async(offset:bigint,length:number)=>{
  const bytes=new Uint8Array(8);
  for(let filled=0;filled<length;){signal?.throwIfAborted();const size=Math.min(length-filled,maxReadBytes),part=await input.readAt(offset+BigInt(filled),size,signal);if(!(part instanceof Uint8Array)||!part.length||part.length>size)invalid('Unexpected audio checkpoint pipeline input read length');bytes.set(part,filled);filled+=part.length;}
  return {id:String.fromCharCode(...bytes.subarray(0,4)),size:new DataView(bytes.buffer).getUint32(4,true)};
 };
 const end=BigInt((await read(0n,8)).size)+8n;let count=0;
 if(end!==input.size)invalid('Audio checkpoint pipeline input with bytes after its RIFF chunk is not implemented');
 for(let offset=12n;offset<end;){
  if(++count>4096)invalid('Audio checkpoint pipeline input chunk count exceeds limit');
  const {id,size}=await read(offset,8),payload=offset+8n,close=payload+BigInt(size),next=close+BigInt(size&1);
  if(carried.includes(id))invalid(`Audio checkpoint pipeline input WAV ${JSON.stringify(id)} chunk is not implemented: the pipeline does not carry input chunks into the output`);
  if(id==='LIST'||id==='list'){
   if(size<4||(await read(payload,4)).id!=='INFO')invalid(`Audio checkpoint pipeline input WAV ${id} chunk other than INFO is not implemented`);
   let at=payload+4n;
   for(;at<close;){
    if(++count>4096)invalid('Audio checkpoint pipeline input chunk count exceeds limit');if(close-at<8n)invalid('Malformed audio checkpoint pipeline input INFO list');
    const entry=await read(at,8);if(entry.id!=='ISFT')invalid(`Audio checkpoint pipeline input metadata ${JSON.stringify(entry.id)} is not implemented: the pipeline does not carry input metadata into the output`);
    at+=8n+BigInt(entry.size);if(at>close)invalid('Malformed audio checkpoint pipeline input INFO list');at+=BigInt(entry.size&1);
   }
   if(at>next)invalid('Malformed audio checkpoint pipeline input INFO list');
  }
  offset=next;
 }
}
/** openWav, the codec/layout checks and the tag scan: everything create, restore and inspect read before any sample. */
async function header(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<{readonly wav:WavInput;readonly input:AudioCheckpointPipelineInput}>{
 const wav=await openWav(input,{maxReadBytes,...(signal?{signal}:{})}),parsed=inputOf(wav.info);await untagged(input,maxReadBytes,signal);return {wav,input:parsed};
}
const inputText=(input:AudioCheckpointPipelineInput)=>JSON.stringify({codec:input.codec,channels:input.channels,sampleRate:input.sampleRate,channelMask:input.channelMask,dataOffset:input.dataOffset,samples:input.samples});
interface Plan {
 readonly config:AudioCheckpointPipelineConfig;readonly input:AudioCheckpointPipelineInput;readonly total:bigint;readonly channels:number;readonly inputRate:number;readonly layout:string;readonly mask:string;
 /** `work` is the resampler state's format: `precision` with a rate change, else the output format (native full_convert). */
 readonly inFormat:ResampleSampleFormat;readonly outFormat:ResampleSampleFormat;readonly work:ResampleSampleFormat;readonly inBlock:number;readonly frameSamples:number;readonly taps:number;
 readonly resampleLimits:{readonly maxFrameBytes:number;readonly maxStateBytes:number};readonly wav:WavOutputFormat;readonly totalOutput:bigint;readonly units:bigint;readonly unitBytes:bigint;readonly stateBytes:number;
}
/** Every static limit, checked before any child state, coefficient bank or frame is allocated. */
function plan(config:AudioCheckpointPipelineConfig,input:AudioCheckpointPipelineInput):Plan{
 if(!exact(input,inputFields)||!Object.hasOwn(codecs,input.codec)||!integer(input.channels,1,65535)||!integer(input.sampleRate,1,2147483647))invalid('Invalid audio checkpoint pipeline input');
 const mask=decimal(input.channelMask,'Invalid audio checkpoint pipeline input channel mask'),total=decimal(input.samples,'Invalid audio checkpoint pipeline input length');decimal(input.dataOffset,'Invalid audio checkpoint pipeline input offset');
 if(total<1n)invalid('Empty audio checkpoint pipeline input is not implemented');
 const {channels,sampleRate:inputRate}=input,{outputRate,precision,codec,stage,unitSamples,limits}=config,inFormat=codecs[input.codec],outFormat=codecs[codec];
 // Equal rates: no resample, rematrix or dither, so swr_init uses full_convert (input to output directly) and ignores tsf.
 const work=inputRate===outputRate?outFormat:precision;
 const layout=defaultChannelLayout(channels)?.mask===mask?defaultChannelLayout(channels)!.name:`mask-${mask}`,inBlock=channels*widths[inFormat];
 // One frame size for every stage, so a resampled frame still fits after conversion to the widest format.
 const frameSamples=Math.floor(limits.maxFrameBytes/(channels*Math.max(widths[inFormat],widths[work],widths[outFormat])));
 if(frameSamples<unitSamples)invalid('Audio checkpoint pipeline unit exceeds maxFrameBytes');
 if(unitSamples*inBlock>limits.maxReadBytes)invalid('Audio checkpoint pipeline unit exceeds maxReadBytes');
 const resampleLimits={maxFrameBytes:frameSamples*channels*widths[work],maxStateBytes:limits.maxStateBytes};
 const {taps,historySamples}=planAudioResample(inputRate,outputRate,channels,{...resampleLimits,sampleFormat:work}),outBlock=BigInt(channels*widths[outFormat]),wav:WavOutputFormat={codec,channels,sampleRate:outputRate,channelMask:mask};
 const muxOptions={metadataProfile:profile,bitexact:config.bitexact},headerBytes=BigInt(createWavMuxState(wav,muxOptions).snapshot().layout.headerBytes);
 const resampled=taps?resampledSampleCount(total,inputRate,outputRate):total,u=BigInt(unitSamples),inputUnits=ceil(total,u);
 // Resampled samples one unit can release: the streaming count over u inputs plus the reflected tail and one pending frame.
 const released=taps?ceil((u+BigInt(taps)+1n)*BigInt(outputRate),BigInt(inputRate))+BigInt(frameSamples):u;
 let totalOutput:bigint,extra:bigint,units=inputUnits;
 if(stage.filter==='asetnsamples'){
  const n=BigInt(stage.samples);if(n*outBlock>BigInt(limits.maxFrameBytes))invalid('Audio checkpoint pipeline asetnsamples frame exceeds maxFrameBytes');
  totalOutput=stage.pad?ceil(resampled,n)*n:resampled;extra=2n*n;
 }else{
  const limit=BigInt(stage.limit),samples=stage.mode.endsWith('_dur')?paddingDurationSamples(limit,outputRate):limit,padding=stage.mode.startsWith('pad')?samples:samples>resampled?samples-resampled:0n,packet=BigInt(stage.packetSamples);
  const largest=padding<packet?padding:packet;if(largest*outBlock>BigInt(limits.maxFrameBytes))invalid('Audio checkpoint pipeline apad packet exceeds maxFrameBytes');
  const packets=ceil(padding,packet),perUnit=BigInt(stage.packetsPerUnit);totalOutput=resampled+padding;extra=perUnit*packet<padding?perUnit*packet:padding;if(packets>perUnit)units+=ceil(packets,perUnit)-1n;
 }
 // Sizes that need RF64 fail here, before the first unit, instead of at the packet that crosses them.
 validateWavOutput(wav,totalOutput,muxOptions);
 if(units>BigInt(limits.maxUnits))invalid('Audio checkpoint pipeline input needs more than maxUnits units');
 const unitBytes=headerBytes+(released+extra)*outBlock+1n;if(unitBytes>BigInt(limits.maxUnitBytes))invalid('Audio checkpoint pipeline unit output bound exceeds maxUnitBytes');
 // Bound on any serialized state: each child codec caps its JSON header (16 KiB, the WAV mux snapshot 1 KiB); the payloads are the
 // resampler history and pending frame and the FIFO remainder. Loose but never below an actual state.
 const align=channels*widths[work],parts=[4+16384+historySamples*align+frameSamples*align,4+16384+(stage.filter==='asetnsamples'?(stage.samples-1)*Number(outBlock):0),1024];
 const stateBytes=4+new TextEncoder().encode(JSON.stringify({version:1,kind:'audio-checkpoint-pipeline',config,input:JSON.parse(inputText(input)) as unknown,parts})).length+parts.reduce((size,part)=>size+part,0);
 return {config,input,total,channels,inputRate,layout,mask:mask.toString(),inFormat,outFormat,work,inBlock,frameSamples,taps,resampleLimits,wav,totalOutput,units,unitBytes,stateBytes};
}
interface Facts {readonly received:bigint;readonly bytes:bigint;readonly finished:boolean}
const sameFormat=(format:{readonly sampleRate:number;readonly channels:number;readonly channelLayout:string;readonly sampleFormat:string},p:Plan)=>format.sampleRate===p.config.outputRate&&format.channels===p.channels&&format.channelLayout===p.layout&&format.sampleFormat===p.outFormat;
/** Child counters must chain: input read = resampler received; resampler emitted minus its pending frame = stage received;
 * stage output = mux samples. Only the pipeline's own phases (fresh, streaming, apad draining, finished) are valid. */
function relate(p:Plan,snapshot:AudioCheckpointPipelineSnapshot):Facts{
 const {resample:r,stage,mux:m}=snapshot,{config}=p,bad=(what:string):never=>invalid('Audio checkpoint pipeline '+what+' disagrees with the pipeline');
 if(r.outputRate!==config.outputRate||r.requestedFormat!==p.work)bad('resampler configuration');
 const received=BigInt(r.received),emitted=BigInt(r.emitted),align=p.channels*widths[p.work];
 if(r.plan===null){if(received!==0n)bad('resampler');}
 else if(r.plan.inputRate!==p.inputRate||r.plan.channels!==p.channels||r.format!.sampleFormat!==p.work||r.format!.channelLayout!==p.layout||r.format!.frameSamples!==p.frameSamples||r.origin!=='0')bad('resampler format');
 if(r.pending.byteLength%align)bad('resampler pending frame');
 const delivered=emitted-BigInt(r.pending.byteLength/align);let output:bigint,eof:boolean,finished:boolean;
 if(stage.filter!==config.stage.filter)bad('stage kind');
 if(stage.filter==='asetnsamples'){
  const s=stage.checkpoint,want=config.stage as Extract<AudioCheckpointPipelineStage,{filter:'asetnsamples'}>;
  if(s.samples!==want.samples||s.pad!==want.pad||(s.format===null?s.origin!==null:!sameFormat(s.format,p)||s.origin!=='0')||BigInt(s.received)!==delivered)bad('asetnsamples state');
  output=BigInt(s.emitted);eof=finished=s.finished;
 }else{
  const s=stage.checkpoint,want=config.stage as Extract<AudioCheckpointPipelineStage,{filter:'apad'}>;
  const e=s.emptyInput;
  if(s.mode!==want.mode||s.limit!==want.limit||s.packetSamples!==want.packetSamples||!e||!sameFormat(e,p)||!e.pts||e.pts.value!=='0'||e.pts.num!=='1'||e.pts.den!==String(config.outputRate)||(s.format===null?s.origin!==null:!sameFormat(s.format,p)||s.origin!=='0')||BigInt(s.received)!==delivered)bad('apad state');
  output=BigInt(s.received)+BigInt(s.padded);eof=s.eof;finished=s.finished;
 }
 const f=m.format;if(f.codec!==config.codec||f.channels!==p.channels||f.sampleRate!==config.outputRate||f.channelMask!==p.mask||m.metadataProfile!==profile||m.bitexact!==config.bitexact||BigInt(m.samples)!==output)bad('WAV mux state');
 const bytes=BigInt(m.bytes);
 if(bytes===0n?received!==0n||r.eof||eof||m.finished:received<1n||received>p.total||(received<p.total?r.eof||eof||m.finished:!r.finished||!eof||m.finished!==finished))bad('phase');
 return {received,bytes,finished:m.finished};
}
const configText=(config:AudioCheckpointPipelineConfig)=>JSON.stringify(config);
function stageBytes(stage:AudioCheckpointPipelineStageCheckpoint,maxFrameBytes:number):Uint8Array{return stage.filter==='asetnsamples'?serializeAudioReframeCheckpoint(stage.checkpoint,{maxFrameBytes}):serializeAudioPadCheckpoint(stage.checkpoint,{maxFrameBytes});}
/** Version 1 binary layout: four-byte little-endian header length, that many bytes of canonical BOM-free UTF-8 JSON
 * `{version,kind,config,input,parts}`, then the resampler, stage and WAV mux snapshots in their own canonical codecs,
 * whose byte lengths are `parts`. Other versions are rejected, never migrated: any change needs a new version number.
 */
export function serializeAudioCheckpointPipeline(snapshot:AudioCheckpointPipelineSnapshot,config:AudioCheckpointPipelineConfig):Uint8Array{
 const wanted=validateAudioCheckpointPipelineConfig(config);
 if(!exact(snapshot,['version','kind','config','input','resample','stage','mux'])||snapshot.version!==1||snapshot.kind!=='audio-checkpoint-pipeline'||!exact(snapshot.stage,['filter','checkpoint'])||snapshot.stage.filter!==wanted.stage.filter)invalid('Invalid audio checkpoint pipeline snapshot version or kind');
 if(configText(validateAudioCheckpointPipelineConfig(snapshot.config))!==configText(wanted))invalid('Audio checkpoint pipeline configuration mismatch');
 // Each child codec validates its own snapshot first; the cross-child relations come after.
 const p=plan(wanted,snapshot.input),parts=[serializeAudioResampleCheckpoint(snapshot.resample,p.resampleLimits),stageBytes(snapshot.stage,wanted.limits.maxFrameBytes),serializeWavMuxState(snapshot.mux)];relate(p,snapshot);
 const header=new TextEncoder().encode(JSON.stringify({version:1,kind:'audio-checkpoint-pipeline',config:wanted,input:JSON.parse(inputText(p.input)) as unknown,parts:parts.map(part=>part.length)}));
 if(header.length>maxHeaderBytes)invalid('Audio checkpoint pipeline header exceeds limit');
 const bytes=new Uint8Array(4+header.length+parts.reduce((size,part)=>size+part.length,0));new DataView(bytes.buffer).setUint32(0,header.length,true);bytes.set(header,4);
 let at=4+header.length;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
}
/** Strict inverse: only the exact canonical bytes serializeAudioCheckpointPipeline produces for `config` decode.
 * Limits come from the caller's configuration, never from the snapshot, and bound the input before parsing. */
export function deserializeAudioCheckpointPipeline(bytes:Uint8Array,config:AudioCheckpointPipelineConfig):AudioCheckpointPipelineSnapshot{
 const wanted=validateAudioCheckpointPipelineConfig(config),{maxFrameBytes,maxStateBytes}=wanted.limits;
 if(!(bytes instanceof Uint8Array)||bytes.length<4||bytes.length>4+maxHeaderBytes+(4+16384+maxStateBytes+maxFrameBytes)+(4+16384+maxFrameBytes)+1024)invalid('Invalid audio checkpoint pipeline bytes');
 const headerBytes=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
 if(headerBytes<2||headerBytes>maxHeaderBytes||4+headerBytes>bytes.length)invalid('Invalid audio checkpoint pipeline header length');
 const header=bytes.subarray(4,4+headerBytes);let decoded:{version:unknown;kind:unknown;config:AudioCheckpointPipelineConfig;input:AudioCheckpointPipelineInput;parts:unknown};
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(header)) as typeof decoded;}catch{invalid('Invalid audio checkpoint pipeline metadata');}
 if(!exact(decoded,fields)||decoded.version!==1||decoded.kind!=='audio-checkpoint-pipeline')invalid('Invalid audio checkpoint pipeline version, kind or fields');
 if(configText(validateAudioCheckpointPipelineConfig(decoded.config))!==configText(wanted))invalid('Audio checkpoint pipeline configuration mismatch');
 const parts=decoded.parts;
 if(!Array.isArray(parts)||parts.length!==3||parts.some(part=>!integer(part,1,bytes.length))||4+headerBytes+(parts as number[]).reduce((size,part)=>size+part,0)!==bytes.length)invalid('Audio checkpoint pipeline part lengths disagree with its bytes');
 const p=plan(wanted,decoded.input),[resampleLength,stageLength]=parts as [number,number,number],start=4+headerBytes;
 const resample=deserializeAudioResampleCheckpoint(bytes.subarray(start,start+resampleLength),p.resampleLimits),stagePart=bytes.subarray(start+resampleLength,start+resampleLength+stageLength);
 const stage:AudioCheckpointPipelineStageCheckpoint=wanted.stage.filter==='asetnsamples'?{filter:'asetnsamples',checkpoint:deserializeAudioReframeCheckpoint(stagePart,{maxFrameBytes})}:{filter:'apad',checkpoint:deserializeAudioPadCheckpoint(stagePart,{maxFrameBytes})};
 const snapshot:AudioCheckpointPipelineSnapshot={version:1,kind:'audio-checkpoint-pipeline',config:wanted,input:p.input,resample,stage,mux:deserializeWavMuxState(bytes.subarray(start+resampleLength+stageLength))};relate(p,snapshot);
 // One encoding per state: the header is compared with its re-encoding; every part already passed its own canonical decoder.
 const canonical=new TextEncoder().encode(JSON.stringify({version:1,kind:'audio-checkpoint-pipeline',config:wanted,input:JSON.parse(inputText(p.input)) as unknown,parts}));
 if(canonical.length!==header.length||canonical.some((value,index)=>value!==header[index]))invalid('Non-canonical audio checkpoint pipeline metadata');
 return snapshot;
}
/** The WAV trailer rewrites for finalization, from the verified terminal committed state alone. */
export function audioCheckpointPipelinePatches(state:Uint8Array,bytes:bigint,config:AudioCheckpointPipelineConfig):readonly WavMuxPatch[]{
 const snapshot=deserializeAudioCheckpointPipeline(state,config);
 if(!snapshot.mux.finished||typeof bytes!=='bigint'||BigInt(snapshot.mux.bytes)!==bytes)invalid('Audio checkpoint pipeline mux state disagrees with the committed output');
 return wavMuxPatches(snapshot.mux);
}
/** Static plan of one input: units it needs, the per-unit output bound, a bound on every serialized state and the exact output
 * length. A Workflow binding compares `units`, `unitBytes` and `stateBytes` with the journal's revision and object limits. */
export interface AudioCheckpointPipelinePlan {readonly input:AudioCheckpointPipelineInput;readonly frameSamples:number;readonly units:number;readonly unitBytes:number;readonly stateBytes:number;readonly outputSamples:bigint;readonly outputBytes:bigint}
/** Read the input header and run every static check `create()` runs, without allocating any child state. */
export async function inspectAudioCheckpointPipeline(config:AudioCheckpointPipelineConfig,input:ReadHandle,signal?:AbortSignal):Promise<AudioCheckpointPipelinePlan>{
 const wanted=validateAudioCheckpointPipelineConfig(config),p=plan(wanted,(await header(input,wanted.limits.maxReadBytes,signal)).input);
 const headerBytes=createWavMuxState(p.wav,{metadataProfile:profile,bitexact:wanted.bitexact}).snapshot().layout.headerBytes,data=p.totalOutput*BigInt(p.channels*widths[p.outFormat]);
 return Object.freeze({input:p.input,frameSamples:p.frameSamples,units:Number(p.units),unitBytes:Number(p.unitBytes),stateBytes:p.stateBytes,outputSamples:p.totalOutput,outputBytes:BigInt(headerBytes)+data+(data&1n)});
}
type Stage={readonly filter:'asetnsamples';readonly state:AudioReframeState}|{readonly filter:'apad';readonly state:AudioPadState};
interface Live {readonly plan:Plan;readonly wav:WavInput;readonly resample:AudioResampleState;readonly stage:Stage;readonly mux:WavMuxState;readonly controller:AbortController;received:bigint;poisoned:boolean;disposed:boolean}
const states=new WeakMap<AudioCheckpointPipelineState,Live>();
function live(state:AudioCheckpointPipelineState):Live{const value=states.get(state);if(!value||value.disposed||value.poisoned)invalid('Audio checkpoint pipeline state is unknown, disposed or poisoned');return value;}
function snapshotOf(value:Live):AudioCheckpointPipelineSnapshot{
 return {version:1,kind:'audio-checkpoint-pipeline',config:value.plan.config,input:value.plan.input,resample:value.resample.checkpoint(),stage:value.stage.filter==='asetnsamples'?{filter:'asetnsamples',checkpoint:value.stage.state.checkpoint()}:{filter:'apad',checkpoint:value.stage.state.checkpoint()},mux:value.mux.snapshot()};
}
/** apad pads even when no resampled frame reached it, from the negotiated format, as native and the CLI's configured input do. */
function padOptions(stage:Extract<AudioCheckpointPipelineStage,{filter:'apad'}>,p:Plan,signal:AbortSignal):AudioPadOptions{
 const rate=p.config.outputRate,emptyInput={sampleRate:rate,channels:p.channels,channelLayout:p.layout,sampleFormat:p.outFormat,pts:{value:0n,timeBase:{num:1n,den:BigInt(rate)}}};
 const limit=BigInt(stage.limit),base={maxFrameBytes:p.config.limits.maxFrameBytes,signal,packetSamples:stage.packetSamples,emptyInput};
 return stage.mode==='pad_len'?{...base,padSamples:limit}:stage.mode==='whole_len'?{...base,wholeSamples:limit}:stage.mode==='pad_dur'?{...base,padDurationMicros:limit}:{...base,wholeDurationMicros:limit};
}
const concat=(chunks:readonly Uint8Array[],size:number)=>{const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
/** Checkpointable continuation of `-i in.wav -af aresample=<rate>:tsf=<precision>p,<asetnsamples|apad> -c:a <codec> out.wav`.
 *
 * Each unit reads `unitSamples` sample frames from `input` with ranged reads (the first unit also emits the WAV header with
 * native's pre-trailer placeholders), pushes them through the resampler, the FIFO or apad and the WAV mux state, and returns
 * the bytes they emitted. The unit that reads the last sample drains the resampler and finishes the FIFO; apad emits at most
 * `packetsPerUnit` silence packets per unit and the WAV trailer comes with the last of them. Hand `audioCheckpointPipelinePatches`
 * to final assembly for the header rewrites. Every limit is checked when the input header is read, before any child allocates.
 * Abort is observed between and inside stages; any failure poisons the in-memory state (restore from the last committed one).
 */
export function createAudioCheckpointPipeline(config:AudioCheckpointPipelineConfig,input:ReadHandle):AudioCheckpointPipeline{
 const wanted=validateAudioCheckpointPipelineConfig(config),{limits,stage}=wanted,frameOptions={maxFrameBytes:limits.maxFrameBytes};
 if(!input||typeof input.readAt!=='function'||typeof input.size!=='bigint')invalid('Invalid audio checkpoint pipeline input handle');
 async function open(saved?:AudioCheckpointPipelineSnapshot):Promise<AudioCheckpointPipelineState>{
  const controller=new AbortController(),{wav,input:parsed}=await header(input,limits.maxReadBytes,controller.signal);
  if(saved&&inputText(saved.input)!==inputText(parsed))invalid('Audio checkpoint pipeline input header changed since the snapshot');
  const p=plan(wanted,parsed),signal=controller.signal,created:{dispose():void}[]=[];
  try{
   const resample=createAudioResampleState(wanted.outputRate,{...p.resampleLimits,sampleFormat:p.work,signal},saved?.resample);created.push(resample);
   let child:Stage;
   if(stage.filter==='asetnsamples'){const state=createAudioReframeState(stage.samples,stage.pad,{...frameOptions,signal},saved?.stage.filter==='asetnsamples'?saved.stage.checkpoint:undefined);created.push(state);child={filter:'asetnsamples',state};}
   else{const state=createAudioPadState(padOptions(stage,p,signal),saved?.stage.filter==='apad'?saved.stage.checkpoint:undefined);created.push(state);child={filter:'apad',state};}
   const mux=createWavMuxState(p.wav,{metadataProfile:profile,bitexact:wanted.bitexact,signal},saved?.mux);
   const value:Live={plan:p,wav,resample,stage:child,mux,controller,received:saved?BigInt(saved.resample.received):0n,poisoned:false,disposed:false};
   const state:AudioCheckpointPipelineState={get received(){return value.received;},get bytes(){return mux.bytes;},get finished(){return mux.finished;},snapshot:()=>snapshotOf(live(state))};
   states.set(state,value);relate(p,snapshotOf(value));return state;
  }catch(error){for(const child of created)child.dispose();throw error;}
 }
 async function read(value:Live,start:bigint,count:number):Promise<MediaPacket>{
  const iterator=value.wav.packets(start,count*value.plan.inBlock)[Symbol.asyncIterator]();
  try{const next=await iterator.next();if(next.done||next.value.data.length!==count*value.plan.inBlock||next.value.pts!==start)invalid('Short audio checkpoint pipeline input read');return next.value;}
  finally{await iterator.return?.();}
 }
 return {
  create:()=>open(),
  restore:async bytes=>open(deserializeAudioCheckpointPipeline(bytes,wanted)),
  async process(state,position,signal){
   const value=live(state),p=value.plan,forward=()=>value.controller.abort(signal?.reason);
   if(signal?.aborted)forward();else signal?.addEventListener('abort',forward,{once:true});
   try{
    value.controller.signal.throwIfAborted();if(position.inputPosition!==String(value.received)||position.outputPosition!==String(value.mux.bytes))invalid('Audio checkpoint pipeline state disagrees with the unit position');
    const chunks:Uint8Array[]=[];let size=0;
    // The static bound makes this unreachable; it still stops before the unit output is assembled.
    const emit=(bytes:Uint8Array)=>{size+=bytes.length;if(BigInt(size)>p.unitBytes)invalid('Audio checkpoint pipeline unit exceeds its output bound');if(bytes.length)chunks.push(bytes);};
    const write=(frame:AudioFrameData)=>emit(value.mux.write(encodePcm(frame,wanted.codec,{...frameOptions,signal:value.controller.signal})));
    const deliver=(frame:AudioFrameData)=>{
     const output=frame.sampleFormat===p.outFormat?frame:convertAudioFrame(frame,p.outFormat,{...frameOptions,signal:value.controller.signal});
     if(value.stage.filter==='asetnsamples'){for(const reframed of value.stage.state.push(output))write(reframed);}else write(value.stage.state.push(output));
    };
    const end=()=>{
     if(value.stage.filter==='asetnsamples'){const tail=value.stage.state.finish();if(tail)write(tail);}else for(const padded of value.stage.state.finish(stage.filter==='apad'?stage.packetsPerUnit:1))write(padded);
     if(value.stage.filter==='asetnsamples'||value.stage.state.finished)emit(value.mux.finish().bytes);
    };
    if(value.mux.bytes===0n)emit(value.mux.start());
    if(value.received<p.total){
     const remaining=p.total-value.received,count=Number(remaining<BigInt(wanted.unitSamples)?remaining:BigInt(wanted.unitSamples)),packet=await read(value,value.received,count);
     const frame=decodePcm(packet,{codec:p.input.codec,channels:p.channels,sampleRate:p.inputRate,channelLayout:p.layout},{...frameOptions,signal:value.controller.signal});
     for(const resampled of value.resample.push(frame.sampleFormat===p.work?frame:convertAudioFrame(frame,p.work,{...frameOptions,signal:value.controller.signal})))deliver(resampled);
     value.received+=BigInt(count);
     if(value.received===p.total){for(const resampled of value.resample.finish())deliver(resampled);end();}
    }else if(value.stage.filter==='apad'&&!value.mux.finished)end();
    else invalid('Audio checkpoint pipeline has no input or padding left');
    return {output:size?concat(chunks,size):null,inputPosition:String(value.received),finished:value.mux.finished};
   }catch(error){value.poisoned=true;throw error;}
   finally{signal?.removeEventListener('abort',forward);}
  },
  serialize(state){const value=live(state);return serializeAudioCheckpointPipeline(snapshotOf(value),wanted);},
  verify(state,position){
   const value=states.get(state);if(!value||value.disposed||value.poisoned||!position||!Number.isSafeInteger(position.revision)||position.revision<0)return false;
   try{const facts=relate(value.plan,snapshotOf(value));return facts.received===value.received&&position.inputPosition===String(facts.received)&&position.outputPosition===String(facts.bytes)&&(position.revision===0)===(facts.bytes===0n);}
   catch{return false;}
  },
  dispose(state){const value=states.get(state);if(!value||value.disposed)return;value.disposed=true;value.resample.dispose();value.stage.state.dispose();}
 };
}
