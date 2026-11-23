import {expect,it} from 'vitest';
import {resolveFlacOutput,validateFlacOutput,muxFlacOutput} from '../../packages/avformat/src/flac-output.js';
import type {FlacOutputAudio,FlacOutputConfiguration} from '../../packages/avformat/src/flac-output.js';

const audio:FlacOutputAudio={channels:2,sampleRate:8000,channelLayout:'stereo',channelMask:3n};
for(const [extension,format,codec] of [['wav','wav','pcm_s16le'],['aiff','aiff','pcm_s16be'],['aif','aiff','pcm_s16be'],['aifc','aiff','pcm_s16be'],['au','au','pcm_s16be'],['snd','au','pcm_s16be']]){
 it(`infers ${extension} with its Native default codec`,()=>{
  expect(resolveFlacOutput(null,null,'/out.'+extension!.toUpperCase())).toEqual({format,codec});
 });
}
it('explicit formats override extensions and explicit codecs override defaults',()=>{
 expect(resolveFlacOutput('au','pcm_f64be','/out.wav')).toEqual({format:'au',codec:'pcm_f64be'});
 expect(resolveFlacOutput('aiff','pcm_s16le','/out.au')).toEqual({format:'aiff',codec:'pcm_s16le'});
 expect(resolveFlacOutput('s24be',null,'/out')).toEqual({format:'s24be',codec:'pcm_s24be'});
 expect(resolveFlacOutput('framecrc',null,'/out')).toEqual({format:'framecrc',codec:'pcm_s16le'});
});
for(const [format,codec,path] of [['aiff','pcm_f32le','/out'],['au','pcm_s16le','/out'],['wav','pcm_s16be','/out'],['s16be','pcm_s16le','/out'],['mp3',null,'/out'],[null,null,'/out'],['','pcm_s16be','/out.aiff'],['aiff','','/out'],['au','copy','/out']]){
 it(`rejects unsupported output ${format}/${codec}/${path}`,()=>{expect(()=>resolveFlacOutput(format,codec,path!)).toThrow();});
}
it('validates empty and finite AIFF/AU headers before any writer exists',()=>{
 for(const format of ['aiff','au']){
  const configuration=resolveFlacOutput(format,null,'/out');
  expect(()=>validateFlacOutput(configuration,audio,0n)).not.toThrow();
  expect(()=>validateFlacOutput(configuration,audio,5n)).not.toThrow();
  expect(()=>validateFlacOutput(configuration,audio,0x100000000n)).toThrow();
  expect(()=>validateFlacOutput(configuration,{...audio,channelMask:0x100000000n},1n)).toThrow();
 }
 expect(()=>validateFlacOutput(resolveFlacOutput('aiff',null,'/out'),{...audio,channelMask:4n},1n)).toThrow(/layout/);
});
it('rejects forged configurations and invalid sample counts rather than skipping validation',()=>{
 for(const configuration of [{format:'au',codec:'pcm_s16le'},{format:'unknown',codec:'pcm_s16be'}] as FlacOutputConfiguration[])expect(()=>validateFlacOutput(configuration,audio,0n)).toThrow();
 for(const sampleCount of [-1n,NaN as unknown as bigint])expect(()=>validateFlacOutput(resolveFlacOutput('au',null,'/out'),audio,sampleCount)).toThrow();
});
it('rejects an invalid mux configuration without consuming packets or writing',async()=>{
 let effects=0;
 async function* packets(){effects++;}
 await expect(muxFlacOutput({async write(){effects++;},async commit(){effects++;},async abort(){effects++;}},{format:'bad',codec:'pcm_s16be'},audio,packets(),{sampleCount:0n,maxWriteBytes:64})).rejects.toThrow(/configuration/);
 expect(effects).toBe(0);
});
