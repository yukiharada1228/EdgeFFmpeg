import {it,expect} from 'vitest';
import {validateWavOutput} from '@edge-ffmpeg/containers';
const format={codec:'pcm_s16le' as const,channels:2,sampleRate:8000,channelMask:3n};
it('validates the same WAV RIFF boundary with the actual software and bitexact profile before allocation',()=>{
 const samples=(0xffffffffn-50n)/4n;
 expect(()=>validateWavOutput(format,samples,{metadataProfile:'ffmpeg-9.0.2',bitexact:true})).not.toThrow();
 expect(()=>validateWavOutput(format,samples,{metadataProfile:'ffmpeg-9.0.2'})).toThrow(/RF64/);
 expect(()=>validateWavOutput(format,0x100000000n)).toThrow(/RF64/);
 expect(()=>validateWavOutput(format,0n)).not.toThrow();
});
