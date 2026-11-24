import {openWav} from '../wav.js';
import {muxWav,supportsWavCodec} from '../wav-mux.js';
import type {WavPcmCodec} from '../wav-mux.js';
import {defineContainer} from '../registry-descriptor.js';
const fourcc=(bytes:Uint8Array)=>String.fromCharCode(...bytes);
/** RIFF/WAVE. RF64, BW64 and RIFX are detected so openWav refuses them explicitly. No pre-output validation: muxWav checks its size fields and aborts. */
export const wav=defineContainer({
  name:'wav',
  demux:{probe:{precedence:40,head:bytes=>['RIFF','RF64','BW64','RIFX'].includes(fourcc(bytes))},headerBytes:128,open:(source,{maxReadBytes,signal})=>openWav(source,{maxReadBytes,signal})},
  mux:{label:'WAV',order:1,extensions:['.wav'],defaultCodec:'pcm_s16le',supports:supportsWavCodec,scratchBytes:128,
    write:(output,{codec,channels,sampleRate,layoutMask,samples,bitexact},packets,{maxWriteBytes,signal})=>muxWav(output,{codec:codec as WavPcmCodec,channels,sampleRate,channelMask:layoutMask},packets,{sampleCount:samples,maxWriteBytes,signal,metadataProfile:'ffmpeg-9.0.2',bitexact})}
});
