import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
// The float recurrences round once per C operation; the pinned evidence is the Linux x86-64 build (macOS arm64 contracts the inverse into FMA).
const linux=process.platform==='linux'&&process.arch==='x64';
/** Deterministic PCM: integer formats use every byte pattern, floating formats overshoot [-1,1] so clipping engages, and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*1.2*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
const options=[-10,-3,0,2,10].flatMap(i=>[0,1].map(c=>`crystalizer=i=${i}:c=${c}`));
it.skipIf(!linux)('matches native framecrc for i {-10,-3,0,2,10} x c {0,1}, packed and planar, on every source into f32, f64 and s16',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-crystalizer-');
  const chains=[...options,...options.map(chain=>`aformat=f=fltp,${chain}`),...options.map(chain=>`aformat=f=dblp,${chain}`)];
  let index=0;
  try{
    for(const [raw,codec,width]of formats){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),2600));
      for(const target of ['pcm_f32le','pcm_f64le','pcm_s16le'])for(const chain of chains){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,codec,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(index).toBe(5*3*30);
},600000);
it.skipIf(!linux)('matches native across channel counts, multi-frame input, asetnsamples splits and composed chains',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-crystalizer-split-');
  const chains=['crystalizer','crystalizer=-3:0','asetnsamples=7,crystalizer=i=-3:c=0','asetnsamples=n=13:p=0,crystalizer=2.5:0','crystalizer=i=10:c=0,asetnsamples=500','asetnsamples=1,crystalizer=-10','crystalizer=-3:0,crystalizer=2:1','volume=0.5,crystalizer=i=-1.5','crystalizer=i=-3:c=0,anull,asetnsamples=64','aformat=f=dbl,crystalizer=i=-3:c=0,aformat=f=s16','apad=pad_len=10:packet_size=7,crystalizer=-2'];
  let index=0;
  try{
    for(const [raw,codec,width]of [formats[1],formats[3],formats[4]])for(const channels of [1,3])for(const chain of chains)for(const target of [codec,'pcm_s16le']){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),3001*channels));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,channels,chain,target,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${chain}/${target}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(index).toBe(3*2*11*2);
},300000);
it.skipIf(!linux)('matches native output time selection, frame limits and WAV/raw files',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-crystalizer-time-');
  let index=0;
  try{
    writeFileSync(join(root,'input.raw'),pcm(4,true,2600*2));
    for(const chain of ['crystalizer=i=-3:c=0','crystalizer=2:1'])for(const output of [['-ss','0.05'],['-t','0.1'],['-ss','0.03','-to','0.2'],['-frames:a','1'],['-ss','0.26','-frames:a','2']]){
      const before=['-cpuflags','0','-f','f32le','-ar','8000','-ac','2'],after=['-af',chain,...output,'-c:a','pcm_f32le','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({chain,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${chain}/${output.join(' ')}`).toBe(expected.toString());
    }
    execFileSync(native,['-v','error','-y','-f','f32le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a','pcm_s16le',join(root,'input.wav')]);
    for(const [container,codec]of [['wav','pcm_f32le'],['wav','pcm_s16le'],['f64le','pcm_f64le']] as const){
      const name=`/${index++}.${container==='wav'?'wav':'pcm'}`,reference=join(root,`reference${name.slice(1)}`),after=['-af','crystalizer=i=-3:c=0','-c:a',codec,'-bitexact','-f',container];
      execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(root,'input.wav'),...after,reference]);
      const result=await frontend.exec(['-cpuflags','0','-i','/input.wav',...after,name]);
      expect(result.exitCode,JSON.stringify({container,codec,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${container}/${codec}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(index).toBe(13);
},120000);
it('fails every unimplemented form before opening output, and records native status for each',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-crystalizer-refuse-');
  // [token, native exit status is zero]: native evaluates expressions, accepts timeline enable and quoted values; it rejects out-of-range and malformed options.
  const cases:[string,boolean][]=[['crystalizer=11',false],['crystalizer=i=-10.0001',false],['crystalizer=c=2',false],['crystalizer=c=auto',false],['crystalizer=1:1:1',false],['crystalizer=intensity=2',false],['crystalizer=i=1+1',true],['crystalizer=i=1k',false],['crystalizer=enable=1',true],['crystalizer=i=1:0',false]];
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,200));
    writeFileSync(join(root,'input.f32'),pcm(4,true,200));
    for(const [index,[chain,accepted]]of cases.entries()){
      const before=['-f','s16le','-ar','8000','-ac','1'],after=['-af',chain,'-c:a','pcm_f32le','-f','f32le'];
      expect(spawnSync(native,['-v','error','-y',...before,'-i',join(root,'input.raw'),...after,join(root,`native${index}.raw`)]).status===0,chain).toBe(accepted);
      const result=await frontend.exec([...before,'-i','/input.raw',...after,`/${index}.raw`]);
      expect(result.exitCode,chain).not.toBe(0);expect(existsSync(join(root,`${index}.raw`)),chain).toBe(false);
    }
    // The shared negotiation guard: after f32 input the chain cannot tell whether native merges volume's {dbl,dblp} into crystalizer's list, so it refuses; native runs it.
    const before=['-f','f32le','-ar','8000','-ac','1'],after=['-af','crystalizer,volume=0.25:precision=double','-c:a','pcm_f32le','-f','f32le'];
    expect(spawnSync(native,['-v','error','-y',...before,'-i',join(root,'input.f32'),...after,join(root,'native-guard.raw')]).status).toBe(0);
    const guarded=await frontend.exec([...before,'-i','/input.f32',...after,'/guard.raw']);
    expect(guarded.diagnostics[0]?.message).toBe('crystalizer with flt input requires unimplemented format negotiation');expect(existsSync(join(root,'guard.raw'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
