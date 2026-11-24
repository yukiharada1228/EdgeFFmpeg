import {openW64,probeW64,muxW64,supportsW64Codec,validateW64Output} from '../w64.js';
import type {W64PcmCodec} from '../w64.js';
import {defineContainer} from '../registry-descriptor.js';
/** Sony Wave64: only a lowercase riff head reads the 40-byte GUID header. */
export const w64=defineContainer({
  name:'w64',
  demux:{probe:{precedence:10,head:bytes=>String.fromCharCode(...bytes)==='riff',confirm:probeW64},headerBytes:128,open:(source,{maxReadBytes,signal})=>openW64(source,{maxReadBytes,signal})},
  mux:{label:'W64',order:4,extensions:['.w64'],defaultCodec:'pcm_s16le',supports:supportsW64Codec,scratchBytes:168,dropsMetadata:true,
    validate:({codec,channels,sampleRate,layoutMask,samples})=>validateW64Output({codec:codec as W64PcmCodec,channels,sampleRate,channelMask:layoutMask},samples),
    write:(output,{codec,channels,sampleRate,layoutMask,samples},packets,{maxWriteBytes,signal})=>muxW64(output,{codec:codec as W64PcmCodec,channels,sampleRate,channelMask:layoutMask},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
