/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded native-FLAC packet-copy route. Pinned flacenc.c/mux.c semantics;
 * pictures and chapter metadata are explicitly unsupported, not silently copied.
 */
import {ExecutionError,ResourceContext} from '@edge-ffmpeg/core';
import type {BackendContext,ReadHandle} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {openFlacDemux,muxFlac} from '@edge-ffmpeg/containers';
import {assertOutputPolicy} from './output-policy.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';
import {snapshotFlacSelection,selectFlacStreams} from './flac-selection.js';
import {flacStreamIdentities} from './flac-stream-identities.js';
import {compileFlacCopyDuration,limitFlacCopyDuration} from './flac-copy-duration.js';
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
/** Observe both outcomes after cancellation, including late provider failures. */
function waitForFlacAbort<T>(pending:PromiseLike<T>|T,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});void Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});if(signal.aborted)abort();});
}
/** Direct helper only: root dispatch must select explicit/inferred FLAC + stream copy.
 * Captures command policy before provider callbacks. Does not decode or re-encode.
 */
export async function executeFlacRemux(command:ParsedCommand,context:BackendContext,probed?:ReadHandle):Promise<readonly string[]>{
 context={...context,budget:Object.freeze({...context.budget})};
 context.signal.throwIfAborted();
 if(command.inputs.length!==1||command.outputs.length!==1)unsupported('FLAC remux requires one input and one output');
 const input=command.inputs[0]!,output=command.outputs[0]!,inputUrl=input.url,outputUrl=output.url;
 const duration=compileFlacCopyDuration(command);
 for(const path of [inputUrl,outputUrl])if(!path.startsWith('/')||path==='/'||path.split('/').includes('..')||path.split('/').includes('.'))unsupported('FLAC remux requires canonical absolute virtual paths');
 if(inputUrl.replace(/\/{2,}/g,'/')===outputUrl.replace(/\/{2,}/g,'/'))unsupported('FLAC input/output paths must differ');
 let overwrite=false,noOverwrite=false,bitexact=false,audio=true,video=true,format:string|null=null,codec:string|null=null,maxPackets:bigint|undefined,copyMetadata=true,copyChapters=true,paddingBytes=8192;
 const maps:string[]=[],metadata:string[]=[];let metadataChars=0;
 for(const option of command.global){if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(option.name!=='-hide_banner')unsupported('Unsupported FLAC remux global option: '+option.name);}
 for(const option of input.options)if(!['-ss','-t','-to'].includes(option.name)&&!(option.name==='-f'&&option.value==='flac')&&option.name!=='-bitexact'&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported('Unsupported FLAC remux input option: '+option.name);
 for(const option of output.options){
  if(/^-(c|codec)(?::(?:a(?::0)?|0))?$/.test(option.name)||option.name==='-acodec')codec=option.value;
  else if(option.name==='-map'){if(maps.length>=64)unsupported('FLAC map limit exceeded');maps.push(option.value??'');}
  else if(option.name==='-vn')video=false;else if(option.name==='-an')audio=false;
  else if(option.name==='-f')format=option.value;
  else if(option.name==='-bitexact'||option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??''))bitexact=true;
  else if(['-frames','-frames:a','-frames:a:0','-frames:0','-aframes'].includes(option.name)){try{maxPackets=parseFrameLimit(option.value??'')??undefined;}catch{throw new ExecutionError('invalid-arguments','Invalid FLAC frame limit');}}
  else if(option.name==='-metadata'){const value=option.value??'';if(value.indexOf('=')<1||value.includes('\0'))throw new ExecutionError('invalid-arguments','Invalid FLAC metadata');metadataChars+=value.length;if(metadata.length>=1024||metadataChars>65536)unsupported('FLAC output metadata budget exceeded');metadata.push(value);}
  else if(option.name==='-map_metadata'){if(!['0','-1'].includes(option.value??''))unsupported('Unsupported FLAC metadata mapping');copyMetadata=option.value==='0';}
  else if(option.name==='-map_chapters'){if(!['0','-1'].includes(option.value??''))unsupported('Unsupported FLAC chapter mapping');copyChapters=option.value==='0';}
  else if(option.name==='-metadata_header_padding'){if(!/^-?\d+$/.test(option.value??''))throw new ExecutionError('invalid-arguments','Invalid FLAC metadata padding');const value=BigInt(option.value!);paddingBytes=value<0n?8192:Number(value>0xffffffn?0xffffffn:value);}
  else if(!['-sn','-dn','-ss','-t','-to'].includes(option.name))unsupported('Unsupported FLAC remux output option: '+option.name);
 }
 if((format??(/\.flac$/i.test(outputUrl)?'flac':null))!=='flac'||codec!=='copy')unsupported('FLAC remux requires native FLAC output and explicit copy codec');
 const selectionPolicy=snapshotFlacSelection({maps,audio,video,defaults:{audio:true,picture:'first'}});
 const resources=new ResourceContext(context.budget,context.signal),signal=context.signal;
 const opened=probed??await waitForFlacAbort(context.filesystem.openRead(inputUrl),signal);signal.throwIfAborted();
 const source=Object.freeze({size:opened.size,readAt:opened.readAt.bind(opened)});
 const demux=await openFlacDemux(source,{resources,signal,maxScanBytes:source.size,maxPacketBytes:source.size,maxReadBytes:Math.min(65536,context.budget.maxBufferBytes),maxMetadataBytes:BigInt(context.budget.maxResidentBytes),maxPictureBytes:Math.min(1048576,context.budget.maxResidentBytes),maxPendingPackets:Math.min(4096,context.budget.maxPendingPackets)});
 try {
  const info=demux.metadata;
  if(info.kind!=='flac-streaminfo')throw new ExecutionError('unsupported-command','FLAC remux requires validated STREAMINFO');
  if(!info.streamInfo?.sampleRate)unsupported('FLAC remux requires validated STREAMINFO');
  const selection=selectFlacStreams(selectionPolicy,flacStreamIdentities(demux));
  if(selection.audioStreamIds.length!==1||selection.pictureStreamIds.length)unsupported('FLAC remux requires exactly one audio stream; attached picture output is unsupported (use -vn)');
  if(copyChapters&&info.chapters.length)unsupported('FLAC chapter remux is unsupported; use -map_chapters -1');
  if(copyMetadata&&(info.deferredCommentEffects.length||info.unparsedMetadataTypes.some(type=>![1,3,6].includes(type))))unsupported('FLAC metadata has unsupported semantics; use -map_metadata -1');
  const block=info.blocks.find(block=>block.type===0&&block.validation==='streaminfo');
  if(!block)unsupported('FLAC remux requires a validated STREAMINFO block');
  const sourceEntries=copyMetadata?info.tagEntries:[];
  const sourceChars=sourceEntries.reduce((sum,entry)=>sum+entry.key.length+entry.value.length,0);
  const release=resources.reserveExternalMemory((metadataChars+sourceChars)*4+(sourceEntries.length+metadata.length+1)*128+34);
  try {
   const entries=sourceEntries.map(entry=>({key:entry.key,value:entry.value}));
   for(const assignment of metadata){const at=assignment.indexOf('='),key=assignment.slice(0,at),value=assignment.slice(at+1),index=entries.findIndex(entry=>entry.key.toLowerCase()===key.toLowerCase());if(index>=0){if(value)entries[index]={key,value};else{entries[index]=entries[entries.length-1]!;entries.pop();}}else if(value)entries.push({key,value});}
   // flacenc reintroduces a non-native channel layout even when format tags are disabled.
   const layout=info.channelLayout;
   if(layout&&!new Set([4n,3n,7n,51n,1543n,1551n,1807n,1599n]).has(layout.mask)&&!entries.some(entry=>entry.key.toLowerCase()==='waveformatextensible_channel_mask'))entries.push({key:'WAVEFORMATEXTENSIBLE_CHANNEL_MASK',value:'0x'+layout.mask.toString(16)});
   const streamInfo=new Uint8Array(34);let at=0;
   while(at<34){signal.throwIfAborted();const requested=Math.min(34-at,context.budget.maxBufferBytes),bytes=await waitForFlacAbort(source.readAt(block!.payloadOffset+BigInt(at),requested,signal),signal);signal.throwIfAborted();if(!bytes.length||bytes.length>requested)throw new Error('Invalid FLAC STREAMINFO read');streamInfo.set(bytes,at);at+=bytes.length;}
   await waitForFlacAbort(assertOutputPolicy(context,outputUrl,overwrite,noOverwrite),signal);signal.throwIfAborted();
   // openOutputGroup owns late handles and cleans them if cancellation wins.
   const group=await waitForFlacAbort(openOutputGroup(context.filesystem,[outputUrl],overwrite,signal),signal);
   try {await muxFlac(group.writers[0]!,limitFlacCopyDuration(demux.packets,duration,signal),{streamInfo,metadataPolicy:{mode:'comments',entries},resources,signal,maxWriteBytes:context.budget.maxBufferBytes,bitexact,paddingBytes,...(maxPackets===undefined?{}:{maxPackets})});await waitForFlacAbort(group.commit(),signal);signal.throwIfAborted();return [outputUrl];}
   catch(error){if(error instanceof OutputGroupError)throw error;try{await waitForFlacAbort(group.abort(error),signal);}catch(cleanup){if(!signal.aborted)throw new OutputGroupError('FLAC remux output cleanup failed',group.effects(),error,[cleanup]);}throw error;}
  }finally{release();}
 }finally{await demux.close();}
}
