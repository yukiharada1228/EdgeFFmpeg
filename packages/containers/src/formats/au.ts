import {openAu,muxAu,supportsAuCodec,validateAuOutput} from '../au.js';
import type {AuCodec} from '../au.js';
import {defineContainer} from '../registry-descriptor.js';
/** Sun AU. The source mask reaches the raw payload writer, which validates it. */
export const au=defineContainer({
  name:'au',
  demux:{probe:{precedence:20,head:bytes=>String.fromCharCode(...bytes)==='.snd'},headerBytes:128,open:(source,{maxReadBytes,signal})=>openAu(source,{maxReadBytes,signal}),seekBeyondEnd:true},
  mux:{label:'AU',order:3,extensions:['.au','.snd'],defaultCodec:'pcm_s16be',supports:supportsAuCodec,scratchBytes:128,
    validate:({codec,channels,sampleRate,samples})=>validateAuOutput({codec:codec as AuCodec,channels,sampleRate},samples),
    write:(output,{codec,channels,sampleRate,channelMask,samples},packets,{maxWriteBytes,signal})=>muxAu(output,{codec:codec as AuCodec,channels,sampleRate,channelMask},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
