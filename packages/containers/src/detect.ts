import type {ReadHandle} from '@edge-ffmpeg/core';
import {probeW64} from './w64.js';
/** Bounded magic probe. Raw media always requires an explicit declaration. */
export async function detectAudioContainer(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<'wav'|'aiff'|'au'|'w64'>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||input.size<4n)throw new Error('Invalid audio container probe');
  const bytes=new Uint8Array(4);let filled=0;
  while(filled<4){signal?.throwIfAborted();const requested=Math.min(4-filled,maxReadBytes),data=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!data.length||data.length>requested)throw new Error('Unexpected audio probe read length');bytes.set(data,filled);filled+=data.length;}
  if(String.fromCharCode(...bytes)==='riff'&&await probeW64(input,maxReadBytes,signal))return 'w64';
  const magic=String.fromCharCode(...bytes);if(magic==='.snd')return 'au';if(magic==='FORM')return 'aiff';if(['RIFF','RF64','BW64','RIFX'].includes(magic))return 'wav';throw new Error('Unsupported audio container signature');
}
