import {openAiff,muxAiff,supportsAiffCodec,validateAiffOutput} from '../aiff.js';
import type {AiffCodec} from '../aiff.js';
import {defineContainer} from '../registry-descriptor.js';
/** AIFF and AIFC under the native aiff name. Packets follow native aiff_read_packet: 4096 bytes rounded down to whole frames. */
export const aiff=defineContainer({
  name:'aiff',
  demux:{probe:{precedence:30,head:bytes=>String.fromCharCode(...bytes)==='FORM'},headerBytes:128,open:(source,{maxReadBytes,signal})=>openAiff(source,{maxReadBytes,signal}),
    packetSpan:info=>BigInt(Math.floor(4096/info.blockAlign)),seekBeyondEnd:true},
  mux:{label:'AIFF',order:2,extensions:['.aif','.aiff','.aifc'],defaultCodec:'pcm_s16be',supports:supportsAiffCodec,scratchBytes:128,
    validate:({codec,channels,sampleRate,channelMask,samples})=>validateAiffOutput({codec:codec as AiffCodec,channels,sampleRate,channelMask},samples),
    write:(output,{codec,channels,sampleRate,channelMask,samples},packets,{maxWriteBytes,signal})=>muxAiff(output,{codec:codec as AiffCodec,channels,sampleRate,channelMask},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
