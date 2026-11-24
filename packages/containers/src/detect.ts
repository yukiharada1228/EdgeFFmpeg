import type {ReadHandle} from '@edge-ffmpeg/core';
import {containerProbes,inputContainerFor} from './registry-table.js';
import type {DetectableContainerName} from './registry-table.js';
/** Bounded magic probe over the registered formats in their fixed precedence; only a matching four-byte head reads further.
 * With `url`, a format registered by input extension is the fallback. Raw media always requires an explicit declaration.
 */
export async function detectAudioContainer(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal,url?:string):Promise<DetectableContainerName>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||input.size<4n)throw new Error('Invalid audio container probe');
  const bytes=new Uint8Array(4);let filled=0;
  while(filled<4){signal?.throwIfAborted();const requested=Math.min(4-filled,maxReadBytes),data=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!data.length||data.length>requested)throw new Error('Unexpected audio probe read length');bytes.set(data,filled);filled+=data.length;}
  for(const format of containerProbes){const probe=format.demux.probe!;if(probe.head(bytes.slice())&&(!probe.confirm||await probe.confirm(input,maxReadBytes,signal)))return format.name as DetectableContainerName;}
  const declared=url===undefined?undefined:inputContainerFor(url);if(declared)return declared.name as DetectableContainerName;
  throw new Error('Unsupported audio container signature');
}
