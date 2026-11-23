import {ExecutionError} from '@edge-ffmpeg/core';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {isPcmCodec} from '@edge-ffmpeg/avcodec';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {muxWav,muxRawPcm,muxFrameCrc,muxAiff,muxAu,rawPcmCodec,supportsWavCodec,validateWavOutput,supportsAiffCodec,supportsAuCodec,validateAiffOutput,validateAuOutput} from '@edge-ffmpeg/containers';
import type {WavMuxOptions} from '@edge-ffmpeg/containers';
export interface FlacOutputConfiguration {readonly format:string;readonly codec:PcmCodec}
export interface FlacOutputAudio {readonly channels:number;readonly sampleRate:number;readonly channelLayout:string;readonly channelMask:bigint|null}
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
/** Resolve explicit format/codec before opening any output transaction. */
export function resolveFlacOutput(format:string|null|undefined,codec:string|null|undefined,path:string):FlacOutputConfiguration{
 const inferred=/\.wav$/i.test(path)?'wav':/\.(aiff|aif|aifc)$/i.test(path)?'aiff':/\.(au|snd)$/i.test(path)?'au':null;
 const selected=format??inferred;if(!selected)unsupported('Cannot infer FLAC decoded output format');
 const raw=rawPcmCodec(selected!);
 if(!raw&&!['wav','aiff','au','framecrc'].includes(selected!))unsupported('Unsupported FLAC decoded output format: '+selected);
 const value=codec??raw??(selected==='aiff'||selected==='au'?'pcm_s16be':'pcm_s16le');
 if(!isPcmCodec(value))unsupported('Unsupported FLAC PCM codec: '+value);
 if(raw&&raw!==value)unsupported('Raw PCM codec must match the output format');
 if(selected==='wav'&&!supportsWavCodec(value)||selected==='aiff'&&!supportsAiffCodec(value)||selected==='au'&&!supportsAuCodec(value))unsupported('Unsupported '+selected+' PCM codec: '+value);
 return Object.freeze({format:selected!,codec:value as PcmCodec});
}
function mask32(mask:bigint|null):number|null{
 if(mask===null)return null;
 if(mask<0n||mask>0xffffffffn)unsupported('AIFF/AU channel mask exceeds 32 bits');
 return Number(mask);
}
/** Validate finite container headers before opening an output transaction. */
export function validateFlacOutput(configuration:FlacOutputConfiguration,audio:FlacOutputAudio,sampleCount:bigint,options:Pick<WavMuxOptions,'metadataProfile'|'bitexact'>={}):void{
 const {codec,format}=resolveFlacOutput(configuration.format,configuration.codec,'');
 if(typeof sampleCount!=='bigint'||sampleCount<0n||!Number.isInteger(audio.channels)||audio.channels<1||audio.channels>8||!Number.isInteger(audio.sampleRate)||audio.sampleRate<1||audio.sampleRate>655350)throw new ExecutionError('invalid-arguments','Invalid FLAC output parameters');
 if(format==='wav'&&supportsWavCodec(codec))validateWavOutput({...audio,codec},sampleCount,options);
 if(format==='aiff'&&supportsAiffCodec(codec))validateAiffOutput({...audio,codec,channelMask:mask32(audio.channelMask)},sampleCount);
 if(format==='au'&&supportsAuCodec(codec))validateAuOutput({...audio,codec,channelMask:mask32(audio.channelMask)},sampleCount);
}
/** Stream encoded packets through existing bounded container muxers. Tags/chapters must be handled or rejected by the caller. */
export async function muxFlacOutput(writer:WriteHandle,configuration:FlacOutputConfiguration,audio:FlacOutputAudio,packets:AsyncIterable<MediaPacket>,options:WavMuxOptions):Promise<void>{
 const {format,codec}=configuration,stable={...audio};
 if(format==='framecrc')return muxFrameCrc(writer,{codec,sampleRate:stable.sampleRate,channelLayout:stable.channelLayout},packets,options);
 if(rawPcmCodec(format)===codec)return muxRawPcm(writer,{codec,channels:stable.channels,sampleRate:stable.sampleRate},packets,options);
 if(format==='wav'&&supportsWavCodec(codec))return muxWav(writer,{codec,channels:stable.channels,sampleRate:stable.sampleRate,channelMask:stable.channelMask},packets,options);
 if(format==='aiff'&&supportsAiffCodec(codec))return muxAiff(writer,{codec,channels:stable.channels,sampleRate:stable.sampleRate,channelMask:mask32(stable.channelMask)},packets,options);
 if(format==='au'&&supportsAuCodec(codec))return muxAu(writer,{codec,channels:stable.channels,sampleRate:stable.sampleRate,channelMask:mask32(stable.channelMask)},packets,options);
 unsupported('Invalid FLAC output configuration');
}
