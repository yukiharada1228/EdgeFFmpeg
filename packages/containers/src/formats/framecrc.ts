import {muxFrameCrc} from '../framecrc.js';
import {containerRefusal,defineContainer} from '../registry-descriptor.js';
/** Output-only per-packet Adler-32 listing of any PCM codec, regrouped to the native packet boundaries of the selected range. */
export const framecrc=defineContainer({
  name:'framecrc',
  mux:{label:'framecrc',order:5,defaultCodec:'pcm_s16le',supports:()=>true,scratchBytes:512,dropsMetadata:true,
    validate:({channelLayout})=>{if(!channelLayout)throw containerRefusal('Unknown channel mask for framecrc output');},
    write:(output,{codec,sampleRate,channelLayout,bitexact},packets,{maxWriteBytes,signal,framing})=>muxFrameCrc(output,{codec,sampleRate,channelLayout},packets,{...(bitexact?{}:{metadataProfile:'ffmpeg-9.0.2' as const}),maxWriteBytes,signal,bitexact,framing})}
});
