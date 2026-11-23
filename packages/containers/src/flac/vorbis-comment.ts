/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted ff_vorbis_comment/plain dictionary semantics from pinned FFmpeg.
 * oggparsevorbis.c also carries the MIT notice retained in COPYING.MIT.oggparsevorbis.
 * FFmpeg n9.0.2 commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * oggparsevorbis.c (2005 Michael Ahlberg, Måns Rullgård), vorbiscomment.c
 * (2009 James Darnley), metadata.c/dict.c (2009 Michael Niedermayer).
 * Pictures/layout effects and diagnostics are deferred, never certified here.
 * Plain invalid UTF8 bytes borrow the caller payload; range reads retain offsets only.
 */
import type {VorbisCommentOptions,VorbisCommentEntry,VorbisCommentDeferred,VorbisCommentCollector,VorbisCommentSnapshotOptions,VorbisCommentResult} from './comment-types.js';
const fold=(text:string)=>text.replace(/[a-z]/g,char=>String.fromCharCode(char.charCodeAt(0)-32));
const conversion=new Map([['ALBUMARTIST','album_artist'],['TRACKNUMBER','track'],['DISCNUMBER','disc'],['DISCSUBTITLE','disc_subtitle'],['DESCRIPTION','comment']]);
export class VorbisCommentLimitError extends Error{}
export function createVorbisCommentCollector({maxEntries=1024,maxDecodedBytes=65536,initialEntries=[],maxStateEntries=4096,maxStateChars=1048576,chapterState=null}:VorbisCommentOptions={}):VorbisCommentCollector{
 for(const n of [maxEntries,maxDecodedBytes])if(!Number.isSafeInteger(n)||n<1)throw new RangeError('Invalid Vorbis comment limits');
 if(!Array.isArray(initialEntries)||!Number.isSafeInteger(maxStateEntries)||maxStateEntries<1||!Number.isSafeInteger(maxStateChars)||maxStateChars<1)throw new RangeError('Invalid initial comment state');if(initialEntries.length>maxStateEntries)throw new VorbisCommentLimitError('Vorbis dictionary state entry budget exceeded');let stateChars=0;for(const entry of initialEntries){if(typeof entry?.key!=='string'||typeof entry.value!=='string')throw new TypeError('Invalid initial comment entry');stateChars+=entry.key.length+entry.value.length;if(stateChars>maxStateChars)throw new VorbisCommentLimitError('Vorbis dictionary state character budget exceeded');}
 const decoder=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}),dictionary:VorbisCommentEntry[]=initialEntries.map(entry=>({...entry})),deferred:VorbisCommentDeferred[]=[];let parsed=0,decodedBytes=0;
 function appendPart(key:string,value:string){const index=dictionary.findIndex(entry=>fold(entry.key)===fold(key));if(index<0)dictionary.push({key,value});else{const old=dictionary[index]!.value;dictionary[index]=dictionary.at(-1)!;dictionary.pop();dictionary.push({key,value:old+value});}}
 function cString(bytes:Uint8Array){const zero=bytes.indexOf(0);return decoder.decode(zero<0?bytes:bytes.subarray(0,zero));}
 function snapshot({parseError=false,remainingBytes=0,missingComments=0}:VorbisCommentSnapshotOptions={}):VorbisCommentResult{const entries:VorbisCommentEntry[]=[];for(const entry of dictionary){const key=conversion.get(fold(entry.key))??entry.key;if(!entries.some(e=>fold(e.key)===fold(key)&&e.value===entry.value))entries.push(Object.freeze({key,value:entry.value}));}return Object.freeze({tags:Object.freeze(Object.fromEntries(entries.map(e=>[e.key,e.value]))),entries:Object.freeze(entries),tagEntries:Object.freeze(entries),deferred:Object.freeze(deferred.slice()),parseError,remainingBytes,missingComments,parsedEntries:parsed,decodedBytes,specialSemanticsComplete:deferred.length===0,diagnosticsMapped:false});}
 function accept(bytes:Uint8Array,location:bigint|null=null){if(!(bytes instanceof Uint8Array)||location!==null&&(typeof location!=='bigint'||location<0n))throw new TypeError('Invalid comment entry');if(parsed>=maxEntries)throw new VorbisCommentLimitError('Vorbis comment entry budget exceeded');parsed++;
  const length=bytes.length,equals=bytes.indexOf(61);if(equals<=0||equals===bytes.length-1)return;if(length>maxDecodedBytes-decodedBytes)throw new VorbisCommentLimitError('Vorbis decoded tag budget exceeded');decodedBytes+=length;let key,value;
  try{key=cString(bytes.subarray(0,equals));value=cString(bytes.subarray(equals+1));}catch{deferred.push(Object.freeze(location===null?{kind:'invalid-utf8',bytes:bytes.subarray(0)}:{kind:'invalid-utf8',sourceRange:Object.freeze({offset:location,bytes:BigInt(bytes.length)})}));return;}
  const normalized=fold(key);if(normalized==='METADATA_BLOCK_PICTURE'){deferred.push(Object.freeze({kind:'picture',key,value}));return;}
  if(normalized.startsWith('CHAPTER')){if(chapterState){if(chapterState.accept(key,value))return;}else{deferred.push(Object.freeze({kind:'chapter',key,value}));return;}}
  if(normalized==='WAVEFORMATEXTENSIBLE_CHANNEL_MASK')deferred.push(Object.freeze({kind:'channel-mask',key,value}));
  if(dictionary.some(entry=>fold(entry.key)===normalized))appendPart(key,';');appendPart(key,value);if(dictionary.length>maxStateEntries||dictionary.reduce((n,e)=>n+e.key.length+e.value.length,0)>maxStateChars)throw new VorbisCommentLimitError('Vorbis dictionary state budget exceeded');

 }
 return {accept,snapshot,get parsedEntries(){return parsed;}};
}
export function parseVorbisCommentPayload(payload:Uint8Array,{maxPayloadBytes=1048576,maxEntries=1024,maxDecodedBytes=65536}:{maxPayloadBytes?:number;maxEntries?:number;maxDecodedBytes?:number}={}){
 if(!(payload instanceof Uint8Array))throw new TypeError('Invalid Vorbis comment payload');if(!Number.isSafeInteger(maxPayloadBytes)||maxPayloadBytes<1)throw new RangeError('Invalid Vorbis comment limits');if(payload.length>maxPayloadBytes)throw new VorbisCommentLimitError('Vorbis comment payload budget exceeded');
 const collector=createVorbisCommentCollector({maxEntries,maxDecodedBytes}),view=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);let position=0,remaining=0,parseError=false;
 const signed=()=>{const value=view.getInt32(position,true);position+=4;return value;},result=()=>collector.snapshot({parseError,remainingBytes:payload.length-position,missingComments:remaining});
 if(payload.length<8){parseError=true;return result();}const vendor=signed();if(vendor<0||payload.length-position-4<vendor){parseError=true;return result();}position+=vendor;remaining=view.getUint32(position,true);position+=4;
 while(payload.length-position>=4&&remaining>0){if(collector.parsedEntries>=maxEntries)throw new VorbisCommentLimitError('Vorbis comment entry budget exceeded');const length=signed();if(length<0||payload.length-position<length)break;collector.accept(payload.subarray(position,position+length));position+=length;remaining--;}
 return result();
}
