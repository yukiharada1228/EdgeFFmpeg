import {ExecutionError} from '@edge-ffmpeg/core';
import type {FlacDecoder,FlacDecoderMetadata} from '@edge-ffmpeg/avcodec';
const MAX_SAMPLES=0x7fffffffffffffffn;
function validateMetadata(info:FlacDecoderMetadata):void{
 if(!Number.isInteger(info.channels)||info.channels<1||info.channels>8||!Number.isInteger(info.sampleRate)||info.sampleRate<1||info.sampleRate>655350||!Number.isInteger(info.bitsPerSample)||info.bitsPerSample<4||info.bitsPerSample>32||typeof info.totalSamples!=='bigint'||info.totalSamples<0n||info.totalSamples>MAX_SAMPLES||!Number.isInteger(info.maxBlockSamples)||info.maxBlockSamples<1||info.maxBlockSamples>65535)throw new ExecutionError('invalid-arguments','Invalid FLAC metadata');
}
/** The decoder is caller-owned. Observe late failures and release frames delivered after abort. */
function nextFrame(decoder:FlacDecoder,signal:AbortSignal):ReturnType<FlacDecoder['next']>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  let pending:ReturnType<FlacDecoder['next']>;
  try{pending=decoder.next();}catch(error){signal.removeEventListener('abort',abort);reject(error);return;}
  void pending.then(item=>{signal.removeEventListener('abort',abort);if(signal.aborted){if(item.status==='frame')item.release();reject(signal.reason);}else resolve(item);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
 });
}
/** Count a selected prefix without retaining borrowed PCM or allocating a second decoder. */
export async function countFlacSamples(decoder:FlacDecoder,info:FlacDecoderMetadata,frames:bigint|null,signal:AbortSignal):Promise<bigint>{
 signal.throwIfAborted();
 if(frames!==null&&(typeof frames!=='bigint'||frames<0n||frames>MAX_SAMPLES))throw new ExecutionError('invalid-arguments','Invalid FLAC frame limit');
 validateMetadata(info);
 // Snapshot caller-owned metadata before awaiting provider work.
 info={...info};
 let samples=0n,count=0n;
 for(;;){
  signal.throwIfAborted();
  if(frames!==null&&count>=frames)return samples;
  const item=await nextFrame(decoder,signal);
  try{
   signal.throwIfAborted();
   validateMetadata(item.metadata);
   if(item.metadata.channels!==info.channels||item.metadata.sampleRate!==info.sampleRate||item.metadata.bitsPerSample!==info.bitsPerSample||item.metadata.totalSamples!==info.totalSamples||item.metadata.maxBlockSamples!==info.maxBlockSamples)throw new ExecutionError('unsupported-command','Changing FLAC parameters are not supported');
   if(item.status==='end'){
    if(info.totalSamples!==0n&&samples!==info.totalSamples)throw new Error('FLAC sample count mismatch');
    return samples;
   }
   if(item.status==='metadata')continue;
   if(item.status!=='frame')throw new ExecutionError('invalid-arguments','Invalid FLAC decoder result');
   if(!Number.isInteger(item.samples)||item.samples<1||item.samples>info.maxBlockSamples||typeof item.samplePosition!=='bigint'||item.samplePosition<0n||item.samplePosition>MAX_SAMPLES-BigInt(item.samples))throw new ExecutionError('invalid-arguments','Invalid FLAC frame metadata');
   if(item.samplePosition!==samples)throw new ExecutionError('unsupported-command','Noncontiguous FLAC timestamps are not supported');
   samples+=BigInt(item.samples);count++;
   if(info.totalSamples!==0n&&samples>info.totalSamples)throw new Error('FLAC sample count mismatch');
  }finally{if(item.status==='frame')item.release();}
 }
}
