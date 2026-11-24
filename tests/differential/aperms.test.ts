import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
const modes=['aperms','aperms=none','aperms=mode=ro','aperms=rw','aperms=mode=toggle','aperms=mode=random:seed=0','aperms=random:7','aperms=mode=random:seed=4294967295'];
const chains=(mode:string)=>[mode,`${mode},volume=0.5`,`asetnsamples=5,${mode}`,`${mode},apad=pad_len=3`,`aperms=toggle,${mode},asetnsamples=5,apad=pad_len=3`];
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=65536){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}})};
}
it('matches native framecrc for every aperms mode and seed on u8 s16 s32 f32 f64 mono and stereo, alone and chained',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aperms-crc-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),37*channels));
      for(const mode of modes)for(const chain of chains(mode)){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('writes native-identical WAV and raw PCM files from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aperms-files-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2])for(const source of ['raw','wav'] as const){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),29*channels));
      const input=source==='raw'?['-f',raw,'-ar','8000','-ac',String(channels),'-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','8000','-ac',String(channels),'-i',join(root,'input.raw'),'-c:a','copy','-bitexact',join(root,'input.wav')]);
      for(const mode of ['aperms','aperms=ro','aperms=toggle','aperms=random:seed=7'])for(const chain of [mode,`${mode},volume=0.5`,`asetnsamples=5,${mode},apad=pad_len=3`])for(const container of ['wav','raw'] as const){
        const name=`/${index++}.${container==='raw'?'pcm':container}`,reference=join(root,`reference${name.slice(1)}`),after=['-af',chain,'-c:a',codec,'-bitexact','-f',container==='raw'?raw:container];
        execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,reference]);
        const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,name]);
        expect(result.exitCode,JSON.stringify({raw,channels,chain,source,container,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${channels}/${chain}/${source}/${container}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('fails explicitly before output for native errors and the unseeded random mode native accepts',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aperms-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));let index=0;
    const run=async(args:string[])=>{const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-f','framecrc','-']).status};};
    // mode=random without a seed (or with seed=-1) calls av_get_random_seed: native succeeds, but the form is refused as nondeterministic.
    // Native also accepts numeric modes and the generic timeline option enable; both stay unimplemented and are refused.
    for(const [filter,nativeAccepts,message]of [['aperms=mode=random',true,'aperms random mode requires an explicit seed'],['aperms=random:seed=-1',true,'aperms random mode requires an explicit seed'],['aperms=seed=-2',false,'Invalid aperms seed: -2'],['aperms=seed=4294967296',false,'Invalid aperms seed: 4294967296'],['aperms=mode=bogus',false,'Unsupported aperms mode: bogus'],['aperms=foo=1',false,'Unsupported aperms option: foo'],['aperms=mode=1',true,'Unsupported aperms mode: 1'],['aperms=enable=1',true,'Unsupported aperms option: enable'],['aperms=ro:7:1',false,'Invalid aperms option']] as const){
      const {result,out,nativeStatus}=await run(['-af',filter]);
      expect(nativeStatus===0,filter).toBe(nativeAccepts);expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics.at(-1)?.message,filter).toContain(message);expect(existsSync(join(root,out.slice(1))),filter).toBe(false);
    }
    // Native resamples after aperms; the step declares no rate conversion, so the chain refuses it.
    const {result,out,nativeStatus}=await run(['-af','aperms=toggle','-ar','16000']);
    expect(nativeStatus).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toMatch(/aperms/);expect(existsSync(join(root,out.slice(1)))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
