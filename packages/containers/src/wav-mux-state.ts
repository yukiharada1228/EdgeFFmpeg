import type {MediaPacket} from '@edge-ffmpeg/avutil';
import type {ReferenceMetadataProfile} from './reference-metadata.js';
import {WavError} from './wav.js';
import {checkWavPacketTiming,supportsWavCodec,wavFactSamples,wavHeader,wavLayout} from './wav-mux.js';
import type {WavOutputFormat,WavPcmCodec} from './wav-mux.js';
/** The continuation models the native reference profile only; `bitexact` drops LIST/INFO as the finite mux does. */
export interface WavMuxStateOptions {readonly metadataProfile:ReferenceMetadataProfile;readonly bitexact?:boolean;readonly signal?:AbortSignal}
export interface WavMuxSnapshot {
 readonly version:1;readonly kind:'wav-mux';
 /** Effective channel mask as a canonical decimal (absent/null masks are 0). */
 readonly format:{readonly codec:WavPcmCodec;readonly channels:number;readonly sampleRate:number;readonly channelMask:string};
 readonly metadataProfile:ReferenceMetadataProfile;readonly bitexact:boolean;
 /** Header length and the byte offsets of the fact count and data size fields; restore re-derives and compares them. */
 readonly layout:{readonly headerBytes:number;readonly factOffset:number|null;readonly dataSizeOffset:number};
 /** Output bytes emitted so far: 0 before start(), then header + data, plus the RIFF pad byte once finished. */
 readonly bytes:string;readonly samples:string;readonly finished:boolean;
}
/** Absolute output byte offset and the bytes native's seekable trailer writes there. */
export interface WavMuxPatch {readonly offset:bigint;readonly bytes:Uint8Array}
export interface WavMuxTrailer {readonly bytes:Uint8Array;readonly patches:readonly WavMuxPatch[]}
/** start() once, write() per contiguous packet, finish() once. Each call validates before mutating, so a
 * rejected packet leaves the state (and its snapshot) unchanged. write() returns the packet bytes uncopied. */
export interface WavMuxState {
 start():Uint8Array;write(packet:MediaPacket):Uint8Array;finish():WavMuxTrailer;snapshot():WavMuxSnapshot;
 readonly bytes:bigint;readonly samples:bigint;readonly finished:boolean;
}
const maxSnapshotBytes=1024;
function invalid(message:string):never{throw new WavError('invalid-data',message);}
function counter(value:unknown):bigint{if(typeof value!=='string'||value.length>20||!/^(?:0|[1-9][0-9]*)$/.test(value))invalid('Invalid WAV mux checkpoint counter');return BigInt(value);}
interface Configuration {readonly format:WavMuxSnapshot['format'];readonly stable:WavOutputFormat;readonly metadataProfile:ReferenceMetadataProfile;readonly bitexact:boolean;readonly layout:WavMuxSnapshot['layout'];readonly blockAlign:number}
function configure(format:WavOutputFormat,metadataProfile:ReferenceMetadataProfile,bitexact:unknown):Configuration{
 if(metadataProfile===undefined)throw new WavError('unsupported','Checkpointed WAV mux requires the native reference metadata profile');
 if(!format||typeof format!=='object'||typeof bitexact!=='boolean')invalid('Invalid WAV mux state configuration');
 const {codec,channels,sampleRate}=format,channelMask=format.channelMask??0;
 if(typeof codec!=='string'||!supportsWavCodec(codec))throw new WavError('unsupported','Unsupported WAV output codec');
 if(typeof channels!=='number'||typeof sampleRate!=='number'||typeof channelMask!=='number'&&typeof channelMask!=='bigint')invalid('Invalid WAV output format or duration');
 // Shared finite layout: validates codec, geometry, mask range and profile exactly as muxWav does.
 const stable={codec,channels,sampleRate,channelMask},derived=wavLayout(stable,0n,metadataProfile,bitexact);
 return {format:{codec,channels,sampleRate,channelMask:derived.mask.toString()},stable,metadataProfile,bitexact,layout:{headerBytes:derived.headerBytes,factOffset:derived.factOffset,dataSizeOffset:derived.dataSizeOffset},blockAlign:derived.blockAlign};
}
const same=(a:Configuration,b:Configuration)=>JSON.stringify([a.format,a.metadataProfile,a.bitexact,a.layout])===JSON.stringify([b.format,b.metadataProfile,b.bitexact,b.layout]);
function encode(config:Configuration,bytes:bigint,samples:bigint,finished:boolean):WavMuxSnapshot{
 const {format,layout}=config;
 return {version:1,kind:'wav-mux',format:{codec:format.codec,channels:format.channels,sampleRate:format.sampleRate,channelMask:format.channelMask},metadataProfile:config.metadataProfile,bitexact:config.bitexact,layout:{headerBytes:layout.headerBytes,factOffset:layout.factOffset,dataSizeOffset:layout.dataSizeOffset},bytes:bytes.toString(),samples:samples.toString(),finished};
}
const profiles:readonly unknown[]=['ffmpeg-9.0.2' satisfies ReferenceMetadataProfile];
function check(value:WavMuxSnapshot):{config:Configuration;bytes:bigint;samples:bigint;finished:boolean}{
 if(!value||typeof value!=='object'||value.version!==1||value.kind!=='wav-mux'||typeof value.finished!=='boolean'||!value.format||typeof value.format!=='object'||!value.layout||typeof value.layout!=='object')invalid('Invalid WAV mux checkpoint version or kind');
 // Untrusted snapshots name only a known profile; an absent or unknown one is invalid data, not a RangeError.
 if(!profiles.includes(value.metadataProfile))invalid('Invalid WAV mux checkpoint metadata profile');
 const mask=counter(value.format.channelMask),config=configure({codec:value.format.codec,channels:value.format.channels,sampleRate:value.format.sampleRate,channelMask:mask},value.metadataProfile,value.bitexact);
 const layout=value.layout;if(layout.headerBytes!==config.layout.headerBytes||layout.factOffset!==config.layout.factOffset||layout.dataSizeOffset!==config.layout.dataSizeOffset)invalid('WAV mux checkpoint header layout disagrees with its format');
 const bytes=counter(value.bytes),samples=counter(value.samples),finished=value.finished;
 if(bytes===0n){if(samples!==0n||finished)invalid('Unstarted WAV mux checkpoint contains output');}
 else{const dataBytes=samples*BigInt(config.blockAlign);wavLayout(config.stable,samples,config.metadataProfile,config.bitexact);if(bytes!==BigInt(config.layout.headerBytes)+dataBytes+(finished?dataBytes&1n:0n))invalid('WAV mux checkpoint byte and sample counters disagree');}
 return {config,bytes,samples,finished};
}
/** Strict canonical UTF-8 JSON; at most 1 KiB. */
export function serializeWavMuxState(snapshot:WavMuxSnapshot):Uint8Array{
 const {config,bytes,samples,finished}=check(snapshot),encoded=new TextEncoder().encode(JSON.stringify(encode(config,bytes,samples,finished)));
 if(encoded.length>maxSnapshotBytes)invalid('WAV mux checkpoint exceeds limit');return encoded;
}
/** Rejects any encoding other than the exact canonical bytes serializeWavMuxState produces. */
export function deserializeWavMuxState(bytes:Uint8Array):WavMuxSnapshot{
 if(!(bytes instanceof Uint8Array)||bytes.length<2||bytes.length>maxSnapshotBytes)invalid('Invalid WAV mux checkpoint length');
 let decoded:WavMuxSnapshot;
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as WavMuxSnapshot;}catch{invalid('Invalid WAV mux checkpoint encoding');}
 if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))invalid('Invalid WAV mux checkpoint encoding');
 const canonical=serializeWavMuxState(decoded);if(canonical.length!==bytes.length||canonical.some((byte,index)=>byte!==bytes[index]))invalid('Non-canonical WAV mux checkpoint encoding');
 const {config,bytes:written,samples,finished}=check(decoded);return encode(config,written,samples,finished);
}
const word=(value:number)=>{const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,true);return bytes;};
/** Header rewrites native's seekable trailer performs, in ascending offset order: RIFF size, fact
 * sample count (non-PCM tags only) and data size. Derived from a finished snapshot alone. */
export function wavMuxPatches(snapshot:WavMuxSnapshot):readonly WavMuxPatch[]{
 const {config,samples,finished}=check(snapshot);if(!finished)invalid('WAV mux header patches require a finished checkpoint');
 const {riffSize,dataBytes,factOffset,dataSizeOffset}=wavLayout(config.stable,samples,config.metadataProfile,config.bitexact);
 return [{offset:4n,bytes:word(Number(riffSize))},...(factOffset===null?[]:[{offset:BigInt(factOffset),bytes:word(wavFactSamples(true,samples))}]),{offset:BigInt(dataSizeOffset),bytes:word(Number(dataBytes))}];
}
/** Checkpointable native-profile PCM WAV mux for output whose sample count is unknown until EOF.
 * Concatenating start(), write() results and finish().bytes, then applying finish().patches, gives the
 * bytes the finite muxWav writes for the same packets and declared sample count. Sizes that would need
 * RF64 fail explicitly when the packet that crosses them is written.
 */
export function createWavMuxState(format:WavOutputFormat,options:WavMuxStateOptions,snapshot?:WavMuxSnapshot):WavMuxState{
 if(!options||typeof options!=='object')invalid('Invalid WAV mux state configuration');
 const signal=options.signal;signal?.throwIfAborted();const config=configure(format,options.metadataProfile,options.bitexact??false),{blockAlign}=config;
 let bytes=0n,samples=0n,finished=false;
 if(snapshot!==undefined){const restored=check(snapshot);if(!same(restored.config,config))invalid('WAV mux checkpoint configuration mismatch');({bytes,samples,finished}=restored);}
 const active=(started:boolean)=>{signal?.throwIfAborted();if(finished||(bytes!==0n)!==started)invalid(started?'WAV mux state is not started or already finished':'WAV mux header was already emitted');};
 const current=()=>encode(config,bytes,samples,finished);
 return {
  start(){active(false);const header=wavHeader(config.stable,0n,config.metadataProfile,config.bitexact,true).bytes;bytes=BigInt(header.length);return header;},
  write(packet){
   active(true);const data=packet?.data;if(!(data instanceof Uint8Array)||!data.byteLength||data.byteLength%blockAlign!==0)invalid('Invalid PCM packet length');
   checkWavPacketTiming(packet,samples*BigInt(blockAlign),blockAlign,config.format.sampleRate);
   const next=samples+BigInt(data.byteLength/blockAlign);wavLayout(config.stable,next,config.metadataProfile,config.bitexact);
   samples=next;bytes+=BigInt(data.byteLength);return data;
  },
  finish(){active(true);const pad=new Uint8Array(Number(samples*BigInt(blockAlign)&1n)),total=bytes+BigInt(pad.length),patches=wavMuxPatches(encode(config,total,samples,true));bytes=total;finished=true;return {bytes:pad,patches};},
  snapshot:current,
  get bytes(){return bytes;},get samples(){return samples;},get finished(){return finished;}
 };
}
