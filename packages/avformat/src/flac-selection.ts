/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped FFmpeg 9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * fftools/ffmpeg_opt.c opt_map, ffmpeg_mux_init.c create_streams and
 * cmdutils.c stream_specifier_parse/stream_specifier_match.
 * Only one FLAC input, its audio stream and attached-picture streams are modeled.
 */
import {ExecutionError} from '@edge-ffmpeg/core';

const LIMIT=64;
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message,{exitCode:234});};
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
export interface FlacSelectionOptions {
 readonly maps:readonly string[];
 /** Output -an/-vn switches; applied AFTER maps have been matched. */
 readonly audio:boolean;
 readonly video:boolean;
 /** Output-format policy, not an inference from which streams can be muxed.
  * framecrc: {audio:true,picture:'first'}; WAV/raw PCM: {audio:true,picture:'none'}.
  * Manual maps still select pictures even for an audio-only output format.
  */
 readonly defaults:Readonly<{audio:boolean;picture:'first'|'none'}>;
}
interface StreamMap {
 readonly negative:boolean;
 readonly optional:boolean;
 readonly kind:'all'|'absolute'|'audio'|'picture'|'non-picture';
 readonly index:number|null;
 readonly metadata?:Readonly<{key:string;value:string|null}>;
 readonly attachedPicture?:boolean;
 readonly usable?:boolean;
}
export interface FlacSelectionPolicy {
 readonly maps:readonly StreamMap[];
 readonly audio:boolean;
 readonly video:boolean;
 readonly defaults:Readonly<{audio:boolean;picture:'first'|'none'}>;
}
export interface FlacStreamIdentities {
 readonly audioStreamId:number;
 /** Demux stream order, not picture block offsets or PICTURE type numbers. */
 readonly pictureStreamIds:readonly number[];
 /** Optional immutable stream-level metadata, NOT container/global tags.
  * Required for metadata matching; usable must be explicitly proven from codec
  * parameters for usable-only matching. Borrowed synchronously, never retained.
  */
 readonly streamDescriptors?:readonly FlacStreamDescriptor[];
}
export interface FlacStreamDescriptor {
 readonly streamId:number;
 readonly tags?:Readonly<Record<string,string>>;
 /** Additional known flags; attached_pic is intrinsic to pictureStreamIds. */
 readonly dispositions?:readonly string[];
 /** Audio: nonzero sample rate/channels and known sample format, after probing.
  * Video: nonzero dimensions and known pixel format, after probing.
  */
 readonly usable?:boolean;
}
export interface FlacStreamSelection {
 /** Output order; duplicates deliberately retained. All IDs refer to input #0. */
 readonly streamIds:readonly number[];
 readonly audioStreamIds:readonly number[];
 readonly pictureStreamIds:readonly number[];
 readonly automatic:boolean;
}
function parseMap(original:string):StreamMap {
 if(typeof original!=='string'||!original.length)invalid('Invalid FLAC stream map');
 if(original.length>128)unsupported('FLAC stream map length limit exceeded');
 // Native parses metadata tokens before opt_map examines its remainder.
 // A trailing '?' is therefore part of the metadata key/value, not allow_unused.
 const metadataSpecifier=/^-?\d+:(?:[avV]:)?m:/.test(original);
 const optional=original.endsWith('?')&&!metadataSpecifier,map=optional?original.slice(0,-1):original,negative=map.startsWith('-'),spec=negative?map.slice(1):map;
 if(/^\[[^\[\]]+\]$/.test(spec))unsupported('FLAC filter output mapping is not implemented');
 const match=/^(\d+)(?::(.*))?$/.exec(spec);
 if(!match)invalid('Invalid FLAC stream map: '+original);
 if(Number(match![1])!==0)invalid('Invalid FLAC input file index: '+match![1]);
 const suffix=match![2];
 let kind:StreamMap['kind']='all',index:number|null=null,metadata:StreamMap['metadata'],attachedPicture:StreamMap['attachedPicture'],usable:StreamMap['usable'];
 if(suffix!==undefined){
  if(/^\d+$/.test(suffix)){kind='absolute';index=Number(suffix);}
  else {
   const typed=/^([avV])(?::(.*))?$/.exec(suffix);
   let rest=suffix;
   if(typed){
    kind=typed[1]==='a'?'audio':typed[1]==='V'?'non-picture':'picture';
    rest=typed[2]??'';
    if(typed[2]==='')invalid('Invalid FLAC stream specifier: '+original);
   }
   if(/^\d+$/.test(rest)&&typed)index=Number(rest);
   else if(rest.startsWith('m:')){
    const fields=rest.slice(2).split(':');
    // av_get_token escaping/quoting is deliberately not approximated.
    if(fields.length>2||/[\\']/.test(rest))unsupported('Unsupported FLAC metadata specifier syntax: '+original);
    const token=(value:string)=>value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,'');
    metadata=Object.freeze({key:asciiLower(token(fields[0]!)),value:fields.length===2?token(fields[1]!):null});
   }else if(rest==='disp:attached_pic')attachedPicture=true;
   else if(rest==='u')usable=true;
   else if(rest!==''||!typed){
    if(/^(?:[Vsdtu]|[mpgi]:|disp:)/.test(rest))unsupported('Unsupported FLAC stream specifier: '+original);
    invalid('Invalid FLAC stream specifier: '+original);
   }
  }
 }
 if(index!==null&&!Number.isSafeInteger(index))invalid('FLAC stream index exceeds safe integer range');
 return Object.freeze({negative,optional,kind,index,...(metadata?{metadata}:{}),...(attachedPicture?{attachedPicture}:{}),...(usable?{usable}:{})});
}
/** AV_DICT_MATCH_CASE is not set by Native; av_strcasecmp is ASCII-only. */
function asciiLower(value:string):string{return value.replace(/[A-Z]/g,char=>char.toLowerCase());}
/** Call synchronously BEFORE the first provider await. Retains no command or payload. */
export function snapshotFlacSelection(options:FlacSelectionOptions):FlacSelectionPolicy {
 if(options.maps.length>LIMIT)unsupported('FLAC map limit exceeded');
 const audio=options.audio,video=options.video,defaults=Object.freeze({audio:options.defaults.audio,picture:options.defaults.picture});
 if(typeof audio!=='boolean'||typeof video!=='boolean'||typeof defaults.audio!=='boolean'||!['first','none'].includes(defaults.picture))invalid('Invalid FLAC output selection policy');
 return Object.freeze({maps:Object.freeze(options.maps.map(parseMap)),audio,video,defaults});
}
/** Pure bounded selection: borrows only bounded scalar descriptors, never readers
 * or picture payloads. No awaits, reservations, I/O, or publication side effects.
 * Negative maps disable ALL existing duplicates. A negative map is valid once any
 * positive match has ever existed, even if nothing matches it (upstream opt_map's
 * m tracks existing map entries). Only unmatched optional maps leave auto enabled;
 * removing every explicit match never re-enables automatic selection.
 */
export function selectFlacStreams(policy:FlacSelectionPolicy,identities:FlacStreamIdentities):FlacStreamSelection {
 if(identities.pictureStreamIds.length+1>LIMIT||policy.maps.length>LIMIT)unsupported('FLAC stream/map limit exceeded');
 const audioId=identities.audioStreamId,pictures=[...identities.pictureStreamIds];
 if(audioId!==0||pictures.some((id,index)=>!Number.isSafeInteger(id)||id<=0||(index>0&&id<=pictures[index-1]!)))invalid('Invalid FLAC demux stream identities');
 const all=[audioId,...pictures];
 const descriptors=new Map<number,FlacStreamDescriptor>();let tagCount=0,tagChars=0;
 if(identities.streamDescriptors){
  if(identities.streamDescriptors.length>LIMIT)unsupported('FLAC stream descriptor limit exceeded');
  for(const descriptor of identities.streamDescriptors){
   if(!all.includes(descriptor.streamId)||descriptors.has(descriptor.streamId))invalid('Invalid FLAC stream descriptor identity');
   if(descriptor.usable!==undefined&&typeof descriptor.usable!=='boolean')invalid('Invalid FLAC usable descriptor');
   if(descriptor.dispositions){
    if(descriptor.dispositions.length>LIMIT)unsupported('FLAC disposition descriptor limit exceeded');
    for(const flag of descriptor.dispositions){
     if(typeof flag!=='string'||flag.length>64)invalid('Invalid FLAC disposition descriptor');
     if(flag==='attached_pic'&&descriptor.streamId===audioId)invalid('FLAC audio cannot be an attached picture');
    }
   }
   if(descriptor.tags)for(const key in descriptor.tags){
    if(!Object.hasOwn(descriptor.tags,key))continue;
    const value=descriptor.tags[key];
    if(typeof value!=='string')invalid('Invalid FLAC stream tag');
    tagCount++;tagChars+=key.length+value!.length;
    if(tagCount>1024||tagChars>65536)unsupported('FLAC stream tag descriptor limit exceeded');
   }
   descriptors.set(descriptor.streamId,descriptor);
  }
 }
 let selected:number[]=[],explicit=false;
 for(const map of policy.maps){
  let matches=map.kind==='all'?all:map.kind==='absolute'?all.filter(id=>id===map.index):map.kind==='audio'?(map.index===null||map.index===0?[audioId]:[]):map.kind==='non-picture'?[]:map.index===null?pictures:pictures.filter((_,index)=>index===map.index);
  if(map.attachedPicture)matches=matches.filter(id=>id!==audioId);
  if(map.metadata)matches=matches.filter(id=>{
   const descriptor=descriptors.get(id);
   // Unknown metadata must not turn an optional map into automatic selection.
   if(!descriptor)unsupported('FLAC metadata selection requires stream descriptors');
   const tags=descriptor!.tags;
   if(tags)for(const key in tags){
    if(Object.hasOwn(tags,key)&&asciiLower(key)===map.metadata!.key)return map.metadata!.value===null||tags[key]===map.metadata!.value;
   }
   return false;
  });
  if(map.usable)matches=matches.filter(id=>{
   const usable=descriptors.get(id)?.usable;
   if(usable===undefined)unsupported('FLAC usable selection requires proven stream codec parameters');
   return usable;
  });
  if(map.negative){
   if(!explicit&&!map.optional)invalid('FLAC map matches no streams');
   selected=selected.filter(id=>!matches.includes(id));
  }else if(matches.length){
   explicit=true;
   if(selected.length+matches.length>LIMIT)unsupported('FLAC selected stream limit exceeded');
   selected.push(...matches);
  }else if(!map.optional)invalid('FLAC map matches no streams');
 }
 if(!explicit){
  // FFmpeg automatic selection creates video before audio, and chooses only the
  // first attached picture (all attached pictures have score 1 for framecrc).
  if(policy.defaults.picture==='first'&&pictures.length)selected.push(pictures[0]!);
  if(policy.defaults.audio)selected.push(audioId);
 }
 selected=selected.filter(id=>id===audioId?policy.audio:policy.video);
 if(!selected.length)invalid('FLAC output has no selected streams');
 return Object.freeze({streamIds:Object.freeze(selected),audioStreamIds:Object.freeze(selected.filter(id=>id===audioId)),pictureStreamIds:Object.freeze(selected.filter(id=>id!==audioId)),automatic:!explicit});
}
