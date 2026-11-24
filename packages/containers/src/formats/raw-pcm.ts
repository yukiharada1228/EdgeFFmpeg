import {openRawPcm,muxRawPcm,rawPcmCodec} from '../raw-pcm.js';
import type {RawPcmFormat} from '../raw-pcm.js';
import {containerRefusal,defineContainer} from '../registry-descriptor.js';
/** Headerless PCM of exactly one codec: parameters come from input declarations, and output is the bare payload. */
function raw<N extends RawPcmFormat>(name:N){
  const codec=rawPcmCodec(name)!;
  return defineContainer({
    name,headerless:true as const,
    demux:{headerBytes:0,open:(source,{maxReadBytes,signal,declared:{channels,sampleRate,guessLayout}})=>openRawPcm(source,{codec,channels,sampleRate,...(guessLayout?{}:{channelMask:null}),maxReadBytes,signal})},
    mux:{label:name,defaultCodec:codec,supports:selected=>selected===codec,refuse:()=>containerRefusal('Raw PCM mux format must match the selected codec'),scratchBytes:0,dropsMetadata:true,
      write:(output,{channels,sampleRate,channelMask,samples},packets,{maxWriteBytes,signal})=>muxRawPcm(output,{codec,channels,sampleRate,channelMask},packets,{sampleCount:samples,maxWriteBytes,signal})}
  });
}
// Every export is a registered format (registry.ts re-exports this module), named as its -f name.
export const s8=raw('s8'),s16be=raw('s16be'),s24be=raw('s24be'),s32be=raw('s32be');
export const u16le=raw('u16le'),u16be=raw('u16be'),u24le=raw('u24le'),u24be=raw('u24be'),u32le=raw('u32le'),u32be=raw('u32be');
export const f32be=raw('f32be'),f64be=raw('f64be'),alaw=raw('alaw'),mulaw=raw('mulaw');
export const u8=raw('u8'),s16le=raw('s16le'),s24le=raw('s24le'),s32le=raw('s32le'),f32le=raw('f32le'),f64le=raw('f64le');
