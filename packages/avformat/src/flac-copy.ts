/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped FFmpeg 9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8
 * fftools/ffmpeg_mux_init.c selection and libavformat/framecrcenc.c;
 * see compat/behavior-specs/flac-cli/README.md for deliberately unsupported routes.
 */
import {ExecutionError,ResourceContext} from '@edge-ffmpeg/core';
import type {ReadHandle,BackendContext} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {openFlacDemux,muxFlacFrameCrc} from '@edge-ffmpeg/containers';
import {assertOutputPolicy} from './output-policy.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';
import {snapshotFlacSelection,selectFlacStreams} from './flac-selection.js';
import {flacStreamIdentities} from './flac-stream-identities.js';
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
/** Provider cancellation is advisory: detach promptly and observe late failures. */
function waitForRead<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  void pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
  if(signal.aborted){signal.removeEventListener('abort',abort);abort();}
 });
}
/** Capture provider capabilities before any provider callback can replace them. */
function retainSource(handle:ReadHandle):ReadHandle{
 const size=handle.size,readAt=handle.readAt.bind(handle);
 return Object.freeze({size,readAt});
}
/** Only undeclared inputs are magic probed. Dispatch chooses eligible output routes; extensions never force FLAC. */
export async function probeFlacInput(command:ParsedCommand,context:BackendContext):Promise<{handle:ReadHandle;explicit:boolean}|null>{
 const explicit=command.inputs.some(file=>file.options.filter(o=>o.name==='-f').at(-1)?.value==='flac');
 if(command.inputs.length!==1)return null;
 const input=command.inputs[0]!,url=input.url,maxBufferBytes=context.budget.maxBufferBytes;
 if(!explicit&&input.options.some(o=>o.name==='-f'))return null;
 context.signal.throwIfAborted();
 const handle=retainSource(await waitForRead(context.filesystem.openRead(url),context.signal));
 if(explicit)return {handle,explicit};
 if(handle.size<4n)return null;
 let magic=0,at=0;
 while(at<4){context.signal.throwIfAborted();const requested=Math.min(4-at,maxBufferBytes),bytes=await waitForRead(handle.readAt(BigInt(at),requested,context.signal),context.signal);context.signal.throwIfAborted();if(!bytes.length||bytes.length>requested)throw new Error('Invalid FLAC probe read');for(const byte of bytes){magic=magic*256+byte;at++;}}
 return magic===0x664c6143?{handle,explicit}:null;
}
/** Compatibility predicate; dispatchers should retain probeFlacInput's handle. */
export async function wantsFlacCopy(command:ParsedCommand,context:BackendContext):Promise<boolean>{return (await probeFlacInput(command,context))!==null;}
export async function executeFlacCopy(command:ParsedCommand,context:BackendContext,probed?:ReadHandle):Promise<readonly string[]>{
 context={...context,budget:Object.freeze({...context.budget})};
 if(command.inputs.length!==1||command.outputs.length!==1)unsupported('FLAC copy requires one input and one output');
 const input=command.inputs[0]!,output=command.outputs[0]!,outputUrl=output.url;
 for(const file of [input,output])if(!file.url.startsWith('/')||file.url==='/')unsupported('FLAC copy requires absolute virtual paths');
 if(input.url.replace(/\/{2,}/g,'/')===output.url.replace(/\/{2,}/g,'/'))unsupported('FLAC input/output paths must differ');
 let overwrite=false,noOverwrite=false,bitexact=false,video=true,audio=true,format:string|null=null,maxPackets:bigint|undefined;
 const maps:string[]=[],codecs:{name:string;value:string|null}[]=[];
 for(const option of command.global){if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(option.name!=='-hide_banner')unsupported('Unsupported FLAC global option: '+option.name);}
 for(const option of input.options)if(!(option.name==='-f'&&option.value==='flac')&&option.name!=='-bitexact'&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported('Unsupported FLAC input option: '+option.name);
 for(const option of output.options){
 if(/^-(c|codec)(?::(?:a(?::0)?|0))?$/.test(option.name)||option.name==='-acodec')codecs.push({name:option.name,value:option.value});
 else if(option.name==='-map'){if(maps.length>=64)unsupported('FLAC map limit exceeded');maps.push(option.value??'');}
 else if(option.name==='-vn')video=false;else if(option.name==='-an')audio=false;
 else if(option.name==='-f')format=option.value;
 else if(option.name==='-bitexact'||option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??''))bitexact=true;
 else if(['-frames','-frames:a','-frames:a:0','-frames:0','-aframes'].includes(option.name)){try{maxPackets=parseFrameLimit(option.value??'')??undefined;}catch{throw new ExecutionError('invalid-arguments','Invalid FLAC frame limit');}}
 else if(option.name==='-metadata'){if(!option.value?.includes('='))throw new ExecutionError('invalid-arguments','Invalid metadata');}
 else if(option.name==='-map_metadata'){if(!['0','-1'].includes(option.value??''))unsupported('Unsupported FLAC metadata mapping');}
 else if(!['-sn','-dn'].includes(option.name))unsupported('Unsupported FLAC output option: '+option.name);
 }
 if(format!=='framecrc')unsupported('FLAC copy currently requires explicit framecrc output');
 if(!codecs.length)unsupported('FLAC framecrc currently requires explicit stream copy');
 const selectionPolicy=snapshotFlacSelection({maps,audio,video,defaults:{audio:true,picture:'first'}});
 context.signal.throwIfAborted();
 const source=retainSource(probed??await waitForRead(context.filesystem.openRead(input.url),context.signal)),resources=new ResourceContext(context.budget,context.signal);
 const demux=await openFlacDemux(source,{resources,signal:context.signal,maxScanBytes:source.size,maxPacketBytes:source.size,maxReadBytes:Math.min(65536,context.budget.maxBufferBytes),maxMetadataBytes:BigInt(context.budget.maxResidentBytes),maxPictureBytes:Math.min(1048576,context.budget.maxResidentBytes),maxPendingPackets:Math.min(4096,context.budget.maxPendingPackets)});
 try{
 const metadata=demux.metadata,info=metadata.kind==='flac-streaminfo'?metadata.streamInfo:null;
 if(!info||!info.sampleRate)unsupported('FLAC copy requires STREAMINFO and a sample rate');
 if(demux.attachedPictures.length>=64)unsupported('FLAC input stream limit exceeded');
 const selection=selectFlacStreams(selectionPolicy,flacStreamIdentities(demux));
 if(selection.pictureStreamIds.length)unsupported('Selected FLAC attached pictures are not supported by framecrc copy; select audio or use -vn');
 const selected=selection.audioStreamIds.length;
 if(selected>1&&maxPackets!==undefined)unsupported('FLAC duplicate-map frame limits are not implemented');
 for(let index=0;index<selected;index++){let codec:string|null=null;for(const option of codecs){const spec=option.name.replace(/^-(?:codec|c)(?=:|$)/,'');if(spec===''||spec===':a'||spec===`:a:${index}`||spec===`:${index}`||option.name==='-acodec')codec=option.value;}if(codec!=='copy')unsupported('Every selected FLAC stream requires explicit copy; decoding requires a configured decoder backend');}
 // STREAMINFO is exactly the 34-byte payload in the validated directory.
 const block=metadata.kind==='flac-streaminfo'?metadata.blocks.find(b=>b.type===0&&b.validation==='streaminfo'):undefined;
 if(!block)unsupported('FLAC copy requires validated STREAMINFO');
 const scratch=resources.allocate(34);
 try{
 const extradata=scratch.data;let at=0;while(at<34){context.signal.throwIfAborted();const requested=Math.min(34-at,context.budget.maxBufferBytes),bytes=await waitForRead(source.readAt(block!.payloadOffset+BigInt(at),requested,context.signal),context.signal);context.signal.throwIfAborted();if(!bytes.length||bytes.length>requested)throw new Error('Truncated FLAC extradata');extradata.set(bytes,at);at+=bytes.length;}
 await waitForRead(assertOutputPolicy(context,outputUrl,overwrite,noOverwrite),context.signal);
 // Keep the group opening in flight so it owns and cleans up late handles.
 const group=await waitForRead(openOutputGroup(context.filesystem,[outputUrl],overwrite,context.signal),context.signal);
 try{await muxFlacFrameCrc(group.writers[0]!,{sampleRate:info!.sampleRate,channelLayout:metadata.channelLayout!.name,extradata,streams:selected},demux.packets,{maxWriteBytes:context.budget.maxBufferBytes,signal:context.signal,bitexact,...(maxPackets===undefined?{}:{maxPackets})});await waitForRead(group.commit(),context.signal);return [outputUrl];}
 catch(error){if(error instanceof OutputGroupError)throw error;try{await waitForRead(group.abort(error),context.signal);}catch(cleanup){if(context.signal.aborted&&cleanup===context.signal.reason)throw error;throw new OutputGroupError('FLAC output cleanup failed',group.effects(),error,[cleanup]);}throw error;}
 }finally{scratch.release();}
 }finally{await demux.close();}
}
