import {createH264TimestampCorrection} from './timestamp.js';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createDecodeOrderH264Decoder,validateH264DecoderOptions as validateRaw} from './decode-order.js';
import type {H264DecoderOptions as RawOptions,H264DecodedFrame} from './decode-order.js';
import {H264InputError,H264ResourceError,inspectH264AnnexB} from './sps.js';
import {createH264DisplayPolicy} from './display-policy.mjs';
export interface H264DecoderOptions extends RawOptions {readonly initialReorderDelay:number;readonly maxDisplayBytes:number}
export function validateH264DecoderOptions(options:H264DecoderOptions):Readonly<H264DecoderOptions>{
 const settings={...options};
 if(!Number.isSafeInteger(settings.initialReorderDelay)||settings.initialReorderDelay<0||settings.initialReorderDelay>16||!Number.isSafeInteger(settings.maxDisplayBytes)||settings.maxDisplayBytes<1||settings.maxDisplayBytes>2147483647)throw new H264InputError('Invalid H264 presentation budget');
 validateRaw(settings);if(settings.maxDisplayBytes>=settings.maxResidentBytes)throw new H264ResourceError('resident-bytes','H264 presentation reservation exceeds resident budget');
 validateRaw({...settings,maxResidentBytes:settings.maxResidentBytes-settings.maxDisplayBytes});return Object.freeze(settings);
}
/** Progressive-picture scheduler with explicit MMCO5 boundaries; recovery and field-picture behavior remain incomplete. */
export function createH264Decoder(module:WebAssembly.Module,options:H264DecoderOptions){
 const settings=validateH264DecoderOptions(options),signal=settings.signal,raw=createDecodeOrderH264Decoder(module,{...settings,maxResidentBytes:settings.maxResidentBytes-settings.maxDisplayBytes}),policy=createH264DisplayPolicy<H264DecodedFrame>({initialDelay:settings.initialReorderDelay,maxQueuedFrames:17,maxQueuedBytes:settings.maxDisplayBytes,...(signal?{signal}:{})});let closed=false,draining=false,rawEnded=false;
 const correctTimestamp=createH264TimestampCorrection();let lastTimeBase={num:1n,den:1n};
 const presentation=(frame:H264DecodedFrame,dts:bigint|null):H264DecodedFrame=>{const value=frame.discard?null:correctTimestamp(frame.frame.pts?.value??null,dts);return {...frame,packetDts:dts,bestEffortTimestamp:value===null?null:{value,timeBase:{...(frame.frame.pts?.timeBase??lastTimeBase)}}};};
 const close=()=>{if(closed)return;closed=true;policy.close();raw.close();};
 const fail=(error:unknown):never=>{try{close();}catch(cleanup){throw new AggregateError([error,cleanup],'H264 display and cleanup failed');}throw error;};
 const check=()=>{signal?.throwIfAborted();if(closed)throw new H264InputError('H264 decoder is closed');};
 const submit=(frame:H264DecodedFrame)=>policy.feed({...frame.pictureOrder,bytes:frame.frame.planes.reduce((n,p)=>n+p.length,0),value:frame}).frame;
 return Object.freeze({get parameters(){return raw.parameters;},get memoryBytes(){return raw.memoryBytes;},get peakWasmMemoryBytes(){return raw.peakWasmMemoryBytes;},get pendingPackets(){return raw.pendingPackets+policy.queuedFrames;},get queuedBytes(){return policy.queuedBytes;},get isClosed(){return closed||raw.isClosed;},
  feed(packet:MediaPacket):readonly H264DecodedFrame[]{try{check();if(draining)throw new H264InputError('H264 decoder is already draining');if(!(packet.data instanceof Uint8Array)||packet.data.length<1)throw new H264InputError('Invalid H264 packet');if(packet.data.length>settings.maxPacketBytes)throw new H264ResourceError('packet-bytes','H264 packet exceeds budget');if(raw.pendingPackets+policy.queuedFrames>=settings.maxPendingPackets&&inspectH264AnnexB(packet.data,settings.maxFrameBytes,settings.maxNalUnits).hasVcl)throw new H264ResourceError('pending-packets','H264 pending packet budget exceeded');lastTimeBase={...packet.timeBase};const frames:H264DecodedFrame[]=[];for(const frame of raw.feed(packet)){const result=submit(frame);if(result)frames.push(presentation(result,packet.dts));}return frames;}catch(error){return fail(error);}},
  flush():H264DecodedFrame|null{try{check();draining=true;while(!rawEnded){const frame=raw.flush();if(frame){const result=submit(frame);if(result)return presentation(result,null);}else rawEnded=true;}const result=policy.flush();return result?presentation(result,null):null;}catch(error){return fail(error);}},close
 });
}
