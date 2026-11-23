import {reduceBoundedRational} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import type {Mp4TrackInfo} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
/** Extract an owned AVC configuration from an indexed visual sample entry. */
export function readMp4AvcDescription(track:Mp4TrackInfo,maxBytes:number,maxBoxes:number,signal?:AbortSignal):{configuration:Uint8Array;sampleAspectRatio?:Rational} {
 signal?.throwIfAborted();
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxBoxes)||maxBoxes<1)throw new ExecutionError('resource-budget','Invalid MP4 AVC configuration budget');
 if(track.type!=='video'||!['avc1','avc3'].includes(track.codecTag))throw new ExecutionError('unsupported-command','Selected MP4 stream is not AVC video');
 const entry=track.sampleEntry;
 const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};
 if(!(entry instanceof Uint8Array)||entry.length<86)invalid('Truncated MP4 AVC visual entry');
 const view=new DataView(entry.buffer,entry.byteOffset,entry.byteLength);if(view.getUint32(0)!==entry.length)invalid('Invalid MP4 AVC visual entry size');
 let at=86,count=0,configuration:Uint8Array|undefined,sampleAspectRatio:Rational|undefined;
 while(at<entry.length){
  signal?.throwIfAborted();if(++count>maxBoxes)throw new ExecutionError('resource-budget','MP4 AVC child box budget exceeded');
  if(entry.length-at<8)invalid('Truncated MP4 AVC child box');
  let size=view.getUint32(at),header=8;
  if(size===1){if(entry.length-at<16)invalid('Truncated MP4 AVC extended child box');const wide=view.getBigUint64(at+8);if(wide>BigInt(entry.length-at))invalid('MP4 AVC child box exceeds entry');size=Number(wide);header=16;}
  else if(size===0)size=entry.length-at;
  if(size<header||size>entry.length-at)invalid('Invalid MP4 AVC child box size');
  if(entry[at+4]===97&&entry[at+5]===118&&entry[at+6]===99&&entry[at+7]===67){
   if(configuration)throw new ExecutionError('unsupported-command','Duplicate MP4 AVC configuration boxes are not connected yet');
   if(size-header>maxBytes)throw new ExecutionError('resource-budget','MP4 AVC configuration exceeds byte budget');
   configuration=entry.slice(at+header,at+size);
  }
  if(entry[at+4]===112&&entry[at+5]===97&&entry[at+6]===115&&entry[at+7]===112){if(size-header<8)invalid('Truncated MP4 pixel aspect ratio');const num=view.getInt32(at+header),den=view.getInt32(at+header+4);if(den){const q=reduceBoundedRational(BigInt(num),BigInt(den));sampleAspectRatio=q.num>0n&&q.den>0n?Object.freeze({num:q.num,den:q.den}):undefined;}}
  at+=size;
 }
 if(!configuration)invalid('Missing MP4 AVC configuration');
 return {configuration:configuration!,...(sampleAspectRatio?{sampleAspectRatio}:{})};
}

export function readMp4AvcConfiguration(track:Mp4TrackInfo,maxBytes:number,maxBoxes:number,signal?:AbortSignal):Uint8Array {
 return readMp4AvcDescription(track,maxBytes,maxBoxes,signal).configuration;
}
