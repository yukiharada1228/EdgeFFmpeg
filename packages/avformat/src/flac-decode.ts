import {ExecutionError,ResourceContext} from '@edge-ffmpeg/core';
import type {BackendContext,ReadHandle} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {createFlacDecoder,encodePcm,getPcmFormat} from '@edge-ffmpeg/avcodec';
import type {FlacDecodedFrame} from '@edge-ffmpeg/avcodec';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import type {RemixArithmetic} from '@edge-ffmpeg/swresample';
import {openFlacDemux} from '@edge-ffmpeg/containers';
import {resolveFlacOutput,validateFlacOutput,muxFlacOutput} from './flac-output.js';
import {countFlacSamples} from './flac-prepass.js';
import {snapshotFlacSelection,selectFlacStreams} from './flac-selection.js';
import {flacStreamIdentities} from './flac-stream-identities.js';
import {compileFlacTransform,executeFlacTransform} from './flac-transform.js';
import {assertOutputPolicy} from './output-policy.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';
export interface FlacBackendConfiguration {
 readonly module:WebAssembly.Module;
 readonly maxReadBytes?:number;
 readonly maxFrameBytes?:number;
 readonly remixArithmetic?:RemixArithmetic;
}
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
/** Detach on cancellation, but always observe late provider rejection. */
function wait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});void pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});if(signal.aborted){signal.removeEventListener('abort',abort);abort();}});
}
/** Finite, bounded FLAC decoding. No runtime filesystem or Native codec dependency. */
export async function executeFlacDecode(command:ParsedCommand,context:BackendContext,configuration:FlacBackendConfiguration,probed?:ReadHandle):Promise<readonly string[]>{
 const {module,maxReadBytes=65536,maxFrameBytes=4194304,remixArithmetic='separate'}=configuration;
 const signal=context.signal,budget=Object.freeze({...context.budget}),filesystem=context.filesystem;
 const openRead=filesystem.openRead.bind(filesystem),openWrite=filesystem.openWrite.bind(filesystem),exists=filesystem.outputExists?.bind(filesystem);
 const stableFs={openRead,openWrite,...(exists?{outputExists:exists}:{})},stableContext={...context,filesystem:stableFs,budget,signal};
 signal.throwIfAborted();
 if(!(module instanceof WebAssembly.Module))unsupported('FLAC decoding requires a trusted precompiled module');
 if(remixArithmetic!=='separate'&&remixArithmetic!=='fused')unsupported('Invalid FLAC remix arithmetic profile');
 if(!Number.isInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>1048576||!Number.isInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>0xffffffff)throw new ExecutionError('invalid-arguments','Invalid FLAC decoder bounds');
 if(command.inputs.length!==1||command.outputs.length!==1)unsupported('FLAC decode currently requires one input and one output');
 const input=command.inputs[0]!,output=command.outputs[0]!;
 const inputPath=input.url,outputPath=output.url;
 if([inputPath,outputPath].some(path=>!path.startsWith('/')||path==='/'||path.split('/').includes('..')))unsupported('FLAC decode requires absolute normalized virtual paths');
 if(inputPath.replace(/\/{2,}/g,'/')===outputPath.replace(/\/{2,}/g,'/'))unsupported('FLAC input/output paths must differ');
 // ParsedCommand is also accepted directly by backends: do not let a missing
 // argument turn an explicit codec/format into an inferred default.
 for(const option of [...command.global,...input.options,...output.options]){
  const flag=['-y','-n','-hide_banner','-bitexact','-vn','-an','-sn','-dn'].includes(option.name);
  if(flag?option.value!==null:typeof option.value!=='string'||option.value.length===0)throw new ExecutionError('invalid-arguments','Invalid FLAC option value: '+option.name);
 }
 let overwrite=false,noOverwrite=false,bitexact=false,format:string|null=null,codec:string|null=null,frames:bigint|null=null,audio=true,video=true,stripMetadata=false;
 const maps:string[]=[];
 for(const option of command.global){if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(option.name==='-bitexact')bitexact=true;else if(option.name==='-cpuflags'&&option.value==='0')continue;else if(option.name!=='-hide_banner')unsupported('Unsupported FLAC global option: '+option.name);}
 for(const option of input.options)if(!(option.name==='-f'&&option.value==='flac')&&option.name!=='-bitexact'&&!['-ss','-t','-to'].includes(option.name)&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported('Unsupported FLAC input option: '+option.name);
 for(const option of output.options){
  if(/^-(c|codec)(?::(?:a(?::0)?|0))?$/.test(option.name)||option.name==='-acodec')codec=option.value;
  else if(option.name==='-f')format=option.value;
  else if(option.name==='-map')maps.push(option.value??'');
  else if(option.name==='-vn')video=false;else if(option.name==='-an')audio=false;
  else if(option.name==='-bitexact'||option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??''))bitexact=true;
  else if(['-frames','-frames:a','-frames:a:0','-frames:0','-aframes'].includes(option.name))frames=parseFrameLimit(option.value??'');
  else if(option.name==='-map_metadata'){if(!['0','-1'].includes(option.value??''))unsupported('Unsupported FLAC metadata mapping');stripMetadata=option.value==='-1';}
  else if(['-ss','-t','-to','-ac','-ac:a','-ac:a:0','-ar','-ar:a','-ar:a:0','-af','-filter:a','-filter:a:0'].includes(option.name))continue;
  else if(!['-sn','-dn'].includes(option.name))unsupported('Unsupported FLAC output option: '+option.name);
 }
 const outputConfiguration=resolveFlacOutput(format,codec,outputPath),outputCodec=outputConfiguration.codec;
 const transform=compileFlacTransform(command,outputConfiguration);
 format=outputConfiguration.format;
 const selectionPolicy=snapshotFlacSelection({maps,audio,video,defaults:{audio:true,picture:format==='framecrc'||format==='aiff'?'first':'none'}});
 const source=probed??await wait(openRead(inputPath),signal),size=source.size,readAt=source.readAt.bind(source);
 const reader:ReadHandle=Object.freeze({size,readAt});
 const resources=new ResourceContext(budget,signal),readBound=Math.min(maxReadBytes,65536,budget.maxBufferBytes);
 // Parse metadata before opening outputs. The existing muxers cannot carry arbitrary tags/chapters.
 const demuxOpening=openFlacDemux(reader,{resources,signal,maxScanBytes:size,maxPacketBytes:size,maxReadBytes:readBound,maxMetadataBytes:BigInt(budget.maxResidentBytes),maxPictureBytes:Math.min(1048576,budget.maxBufferBytes),maxPendingPackets:Math.min(4096,budget.maxPendingPackets)});
 void demuxOpening.then(value=>{if(signal.aborted)void value.close().catch(()=>{});},()=>{});
 const demux=await wait(demuxOpening,signal);
 let layout:string,mask:bigint|null;
 try{
  const metadata=demux.metadata;
  if(metadata.kind!=='flac-streaminfo'||!metadata.channelLayout)unsupported('FLAC decoding requires validated STREAMINFO');
  layout=metadata.channelLayout!.name;mask=metadata.channelLayout!.mask;
  const selection=selectFlacStreams(selectionPolicy,flacStreamIdentities(demux));
  if(selection.pictureStreamIds.length)unsupported('Selected FLAC attached pictures cannot be preserved; select audio or use -vn');
  if(selection.audioStreamIds.length!==1)unsupported('FLAC decode requires exactly one selected audio stream');
  if(metadata.chapters.length)unsupported('FLAC chapter preservation is not implemented');
  if(!stripMetadata&&Object.keys(metadata.tags).some(key=>key.toLowerCase()!=='encoder'))unsupported('FLAC tags/chapters cannot yet be preserved; use -map_metadata -1');
 }finally{await demux.close();}
 if(transform)return executeFlacTransform(reader,stableContext,resources,{module,maxReadBytes,maxFrameBytes,remixArithmetic},transform,outputConfiguration,{input:inputPath,output:outputPath},{frameLimit:frames,overwrite,noOverwrite,bitexact});
 const scratch=resources.reserveExternalMemory(512+readBound);
 let held:FlacDecodedFrame|undefined;
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,group:Awaited<ReturnType<typeof openOutputGroup>>|undefined;
 try{
  decoder=await createFlacDecoder(module,reader,{signal,maxReadBytes:readBound,maxFrameBytes,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  const initial=await decoder.next();
  if(initial.status!=='metadata')throw new Error('FLAC decoder did not initialize metadata');
  const info=initial.metadata;
  // Header-bearing muxers require the selected decoded sample count up front.
  // Re-decode a bounded frame at a time; never retain the input or decoded output.
  let sampleCount=frames===0n?0n:info.totalSamples;
  const prepass=format!=='framecrc'&&frames!==0n&&(frames!==null||info.totalSamples===0n);
  if(prepass){
   sampleCount=await countFlacSamples(decoder,info,frames,signal);
   await decoder.close();decoder=undefined;
   decoder=await createFlacDecoder(module,reader,{signal,maxReadBytes:readBound,maxFrameBytes,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
   const restart=await decoder.next();
   if(restart.status!=='metadata'||restart.metadata.channels!==info.channels||restart.metadata.sampleRate!==info.sampleRate||restart.metadata.bitsPerSample!==info.bitsPerSample||restart.metadata.totalSamples!==info.totalSamples)unsupported('FLAC metadata changed between decoder passes');
  }
  const audioFormat={channels:info.channels,sampleRate:info.sampleRate,channelLayout:layout!,channelMask:mask!};
  validateFlacOutput(outputConfiguration,audioFormat,sampleCount,{metadataProfile:'ffmpeg-9.0.2',bitexact});
  if(frames!==0n){for(;;){const item=await decoder.next();if(item.status==='metadata')continue;if(item.status==='frame')held=item;break;}}
  await wait(assertOutputPolicy(stableContext,outputPath,overwrite,noOverwrite),signal);
  const opening=openOutputGroup(stableFs,[outputPath],overwrite,signal);
  void opening.then(value=>{if(signal.aborted)void value.abort(signal.reason).catch(()=>{});},()=>{});
  group=await wait(opening,signal);
  async function* packets():AsyncIterable<MediaPacket>{
   if(frames===0n)return;
   let emitted=0n,frameCount=0n;
   for(;;){if(frames!==null&&frameCount>=frames){if(prepass&&emitted!==sampleCount)throw new Error('FLAC prepass sample count mismatch');return;}const item=held??await decoder!.next();held=undefined;if(item.status==='end'){if(prepass&&emitted!==sampleCount)throw new Error('FLAC prepass sample count mismatch');if(info.totalSamples!==0n&&emitted!==info.totalSamples)throw new Error('FLAC sample count mismatch');return;}if(item.status==='metadata'){if(item.metadata.channels!==info.channels||item.metadata.sampleRate!==info.sampleRate||item.metadata.bitsPerSample!==info.bitsPerSample)unsupported('Changing FLAC parameters are not supported');continue;}if(item.status!=='frame')throw new Error('Unexpected FLAC decoder result');
    try{
     if(item.samplePosition!==emitted)unsupported('Noncontiguous FLAC timestamps are not supported');
     // Framecrc retains decoder frame boundaries. Other muxers accept bounded PCM chunks.
     const widest=Math.max(4,getPcmFormat(outputCodec).frameBytesPerSample,getPcmFormat(outputCodec).bytesPerSample),chunkSamples=format==='framecrc'?item.samples:Math.floor(budget.maxBufferBytes/(widest*info.channels));
     if(chunkSamples<1||chunkSamples*info.channels*widest>budget.maxBufferBytes)throw new ExecutionError('resource-budget','FLAC PCM frame exceeds buffer budget');
     for(let at=0;at<item.samples;at+=chunkSamples){signal.throwIfAborted();const count=Math.min(chunkSamples,item.samples-at),bytes=count*info.channels*4;
      const release=resources.reserveExternalMemory(count*info.channels*(4+widest+getPcmFormat(outputCodec).bytesPerSample));
      try{const packed=new Uint8Array(bytes),view=new DataView(packed.buffer),shift=32-info.bitsPerSample;
       for(let sample=0;sample<count;sample++){if((sample&1023)===0)signal.throwIfAborted();for(let channel=0;channel<info.channels;channel++)view.setInt32((sample*info.channels+channel)*4,item.planes[channel]![at+sample]!<<shift,true);}
       const packet=encodePcm({sampleRate:info.sampleRate,channels:info.channels,channelLayout:layout,sampleFormat:'s32',samples:count,planes:[packed],pts:{value:emitted,timeBase:{num:1n,den:BigInt(info.sampleRate)}}},outputCodec,{maxFrameBytes:budget.maxBufferBytes,signal});
       emitted+=BigInt(count);yield packet;
      }finally{release();}
     }
    }finally{item.release();}frameCount++;
   }
  }
  const destination=group.writers[0]!;
  const writer={async write(chunk:Uint8Array){const release=resources.reserveExternalMemory(chunk.length);let pending:Promise<void>;try{pending=Promise.resolve(destination.write(chunk));}catch(error){release();throw error;}void pending.then(release,release);await wait(pending,signal);},commit:()=>wait(destination.commit(),signal),abort:(reason?:unknown)=>wait(destination.abort(reason),signal)};
  const options={sampleCount,maxWriteBytes:budget.maxBufferBytes,signal,metadataProfile:'ffmpeg-9.0.2' as const,bitexact};
  await muxFlacOutput(writer,outputConfiguration,audioFormat,packets(),options);
  await wait(group.commit(),signal);return [outputPath];
 }catch(error){if(group&&!(error instanceof OutputGroupError))try{await wait(group.abort(error),signal);}catch(cleanup){throw new OutputGroupError('FLAC decode cleanup failed',group.effects(),error,[cleanup]);}throw error;
 }finally{held?.release();try{await decoder?.close();}finally{scratch();}}
}
