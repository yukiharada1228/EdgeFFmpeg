/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Composition derived from FFmpeg 9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8
 * libavformat/flacdec.c/flac_picture.c (Fabrice Bellard), oggparsevorbis.c
 * (Michael Ahlberg, Måns Rullgård, MIT). No CUESHEET/SEEKTABLE interpretation.
 */
import {readFlacMetadata} from './metadata.js';
import {readVorbisCommentRange} from './vorbis-comment-stream.js';
import {createVorbisChapterState} from './chapters.js';
import {applyFlacChannelMask,resolveFlacLayout} from './channel-mask.js';
import {readFlacPictureRange} from './picture-reader.js';
import {createReferenceBase64Source} from './base64-source.js';
import {FlacPictureMetadataError} from './picture-errors.js';
import {readFlacPacketChunks} from './payload.js';
import type {FlacMetadataOptions} from './metadata-types.js';
import type {FlacPictureOptions} from './picture-types.js';
import type {VorbisCommentEntry,VorbisCommentDeferred} from './comment-types.js';
import type {FlacRangeSource} from './types.js';
export interface FlacDemuxMetadataOptions extends Omit<FlacMetadataOptions,'handleUnsupportedBlock'>,FlacPictureOptions {
 readonly maxTotalCommentEntries?:number;readonly maxTotalCommentBytes?:number;readonly maxChapters?:number;
 readonly maxPictures?:number;readonly maxPictureMetadataBytes?:number;readonly maxPictureEncodedChars?:number;
}
export async function readFlacDemuxMetadata(source:FlacRangeSource,options:FlacDemuxMetadataOptions){
 const {signal}=options,maxEntries=options.maxTotalCommentEntries??1024,maxBytes=options.maxTotalCommentBytes??65536,maxPictures=options.maxPictures??32;
 if(![maxEntries,maxBytes,maxPictures].every(n=>Number.isSafeInteger(n)&&n>0))throw new RangeError('Invalid FLAC metadata context limits');
 const chapters=createVorbisChapterState(options);let entries:readonly VorbisCommentEntry[]=[],mask:bigint|null=null,parsed=0,decoded=0;
 const deferred:VorbisCommentDeferred[]=[],pictures:{source:FlacRangeSource;parsed:Awaited<ReturnType<typeof readFlacPictureRange>>}[]=[];
 const diagnostics:Readonly<{transport:string;kind:string;reason:string|null}>[]=[];
 async function picture(input:FlacRangeSource,offset:bigint,bytes:number,transport:'block'|'comment'){
  let result=await readFlacPictureRange(input,{...options,payloadOffset:offset,payloadBytes:bytes,transport,maxPayloadBytes:options.maxPictureMetadataBytes??1048576});
  const descriptor=result.descriptor;
  if(descriptor.fatal)throw new FlacPictureMetadataError(descriptor.reason);
  let end=offset+BigInt(bytes);
  if(descriptor.kind==='needs-truncation-read'){
   end+=BigInt(descriptor.additionalBytes);
   if(end>input.size||(transport==='block'?end-4n:end-offset)>(options.maxMetadataBytes??67108864n))throw new RangeError('FLAC picture continuation bounds exceeded');
   if(!result.dataRange)throw new Error('Missing picture continuation range');
   // Consume the actual parser-requested image span before accepting the next header.
   for await(const chunk of readFlacPacketChunks(input,result.dataRange,{...options,maxPacketBytes:BigInt(options.maxPictureBytes??1048576),checkpoint:async()=>{await options.checkpoint?.();}}))chunk.release();
   result=await readFlacPictureRange(input,{...options,payloadOffset:offset,payloadBytes:Number(end-offset),transport,maxPayloadBytes:Math.max(options.maxPictureMetadataBytes??1048576,Number(end-offset))});
  }
  diagnostics.push(Object.freeze({transport,kind:result.descriptor.kind,reason:'reason' in result.descriptor?result.descriptor.reason:null}));
  if(result.descriptor.kind==='accepted'){
   if(pictures.length>=maxPictures)throw new RangeError('Attached picture limit exceeded');pictures.push({source:input,parsed:result});
  }
  return {effectiveEndOffset:end,payloadValidated:result.descriptor.kind!=='deferred'&&result.descriptor.kind!=='needs-truncation-read'};
 }
 const raw=await readFlacMetadata(source,{...options,handleUnsupportedBlock:async block=>{
  if(block.type===6)return picture(source,block.payloadOffset,block.length,'block');
  if(block.type!==4)return null;
  const result=await readVorbisCommentRange(source,{...options,payloadOffset:block.payloadOffset,payloadBytes:block.length,initialEntries:entries,chapterState:chapters,maxEntries:Math.max(1,maxEntries-parsed),maxDecodedBytes:Math.max(1,maxBytes-decoded),maxStateEntries:maxEntries,maxStateChars:maxBytes});
  parsed+=result.parsedEntries;decoded+=result.decodedBytes;if(parsed>maxEntries||decoded>maxBytes)throw new RangeError('Aggregate FLAC comment budget exceeded');
  const effect=applyFlacChannelMask(result.entries,mask);mask=effect.mask;entries=effect.entries;
  for(const item of result.deferred){if(item.kind==='channel-mask')continue;if(item.kind!=='picture'){deferred.push(item);continue;}
   const input=createReferenceBase64Source(item.value,{signal,maxReadBytes:options.maxReadBytes??65536,maxEncodedChars:options.maxPictureEncodedChars??1048576,maxDecodedBytes:options.maxPictureMetadataBytes??1048576});
   if(input&&input.size>0n){const handled=await picture(input,0n,Number(input.size),'comment');if(!handled.payloadValidated)deferred.push(item);}
  }
  return {effectiveEndOffset:block.advertisedEndOffset,payloadValidated:!result.parseError&&result.specialSemanticsComplete};
 }});
 const info=raw.kind==='flac-streaminfo'?raw.streamInfo:null;
 const durationUs=info&&info.sampleRate&&info.totalSamples>0n?(info.totalSamples*1000000n+BigInt(Math.floor(info.sampleRate/2)))/BigInt(info.sampleRate):null;
 return {metadata:Object.freeze({...raw,tags:Object.freeze(Object.fromEntries(entries.map(e=>[e.key,e.value]))),tagEntries:entries,chapters:chapters.snapshot({durationUs}),declaredChannelMask:mask,channelLayout:info?resolveFlacLayout(info.channels,mask):null,channelLayoutProvisionalUntilFrameHeader:true,commentChaptersOnly:true,deferredCommentEffects:Object.freeze(deferred),pictureMetadataDiagnostics:Object.freeze(diagnostics),attachedPictureCount:pictures.length,picturePixelsDecoded:false,metadataValidationComplete:false}),pictures};
}
