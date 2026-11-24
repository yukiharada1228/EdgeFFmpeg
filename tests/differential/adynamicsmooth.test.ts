import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
// Double arithmetic is compared bit for bit with the pinned Linux x86_64 build; other hosts' natives may contract multiply-adds (macOS arm64 matched 8228/10000 samples).
const linux=process.platform==='linux'&&process.arch==='x64';
const floatIt=linux?it:it.skip;
if(!linux)console.warn('adynamicsmooth differential tests skipped: double results are pinned against the linux/x64 native build only');
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1], include -0 and jumps that drive the sensitivity term. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.max(-1,Math.min(1,Math.sin(i*0.731)*((i%13)/12)+(i%97<3?0.8:0)));if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
type Frontend=Awaited<ReturnType<typeof harness>>['frontend'];
let index=0;
async function compare(root:string,frontend:Frontend,input:string,before:string[],after:string[],label:string){
  // Native writes a seekable file too, so WAV/AIFF headers are finalised the same way.
  const out=`/${index++}.out`,reference=join(root,`reference${index}.out`);execFileSync(native,['-v','error','-y',...before,'-i',join(root,input),...after,reference]);
  const expected=readFileSync(reference),result=await frontend.exec([...before,'-i',`/${input}`,...after,out]);
  expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);
  expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);
}
floatIt('matches native framecrc bytes for every sensitivity and base frequency on all sources, 1-3 channels and f64/f32/s16 outputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adynamicsmooth-');
  try{
    for(const [raw,,width]of formats)for(const channels of [1,2,3]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),2500*channels));
      for(const sensitivity of ['0','2','1000'])for(const basefreq of ['2','1000','22050','1000000'])for(const codec of ['pcm_f64le','pcm_f32le','pcm_s16le']){
        await compare(root,frontend,'input.raw',['-cpuflags','0','-f',raw,'-ar','44100','-ac',String(channels)],['-af',`adynamicsmooth=sensitivity=${sensitivity}:basefreq=${basefreq}`,'-c:a',codec,'-bitexact','-f','framecrc'],`${raw}/${channels}/${sensitivity}/${basefreq}/${codec}`);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
floatIt('matches native across composed chains, asetnsamples splits, defaults, positional options and output time selection',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adynamicsmooth-chain-');
  const chains=['adynamicsmooth','adynamicsmooth=2:1000','adynamicsmooth=basefreq=300.5:sensitivity=0.75','asetnsamples=7:p=0,adynamicsmooth=2:1000','asetnsamples=1,adynamicsmooth=1000:2','adynamicsmooth=2:1000,asetnsamples=500','asetnsamples=333,adynamicsmooth=2:1000,asetnsamples=5:p=0','volume=0.5,adynamicsmooth=2:1000','adynamicsmooth=2:1000,volume=0.5:precision=double','aformat=s32p,adynamicsmooth=2:1000,aformat=fltp','adynamicsmooth=2:1000,apad=pad_len=100','apad=pad_len=100,adynamicsmooth=1000:22050','adynamicsmooth=2:1000,adynamicsmooth=1000:1000000','adelay=5S|9S,adynamicsmooth=2:1000'];
  const profiles=[[],['-ss','0.01'],['-t','0.03'],['-ss','0.02','-t','0.01'],['-frames:a','2'],['-to','0.05']];
  try{
    for(const [raw,codec,width]of [formats[1],formats[4]])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),3000*channels));
      for(const chain of chains)for(const output of profiles)for(const target of codec==='pcm_s16le'?[codec,'pcm_f64le']:[codec,'pcm_s16le']){
        await compare(root,frontend,'input.raw',['-cpuflags','0','-f',raw,'-ar','44100','-ac',String(channels)],['-af',chain,...output,'-c:a',target,'-bitexact','-f','framecrc'],`${raw}/${channels}/${chain}/${output.join(' ')}/${target}`);
      }
    }
    // Input time selection and other sample rates (wc = basefreq / rate).
    writeFileSync(join(root,'input.raw'),pcm(8,true,4000*2));
    for(const rate of ['8000','22050','48000'])for(const input of [[],['-ss','0.01'],['-t','0.05']])await compare(root,frontend,'input.raw',['-cpuflags','0','-f','f64le','-ar',rate,'-ac','2',...input],['-af','adynamicsmooth=2:1000','-c:a','pcm_f64le','-bitexact','-f','framecrc'],`rate ${rate} ${input.join(' ')}`);
    // Empty input yields no samples.
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));
    for(const chain of ['adynamicsmooth','adynamicsmooth,apad=pad_len=10'])await compare(root,frontend,'empty.raw',['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],['-af',chain,'-c:a','pcm_s16le','-bitexact','-f','framecrc'],`empty ${chain}`);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
floatIt('writes native-identical WAV, AIFF and raw PCM files from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adynamicsmooth-files-');
  try{
    for(const [raw,codec,width]of formats)for(const source of ['raw','wav'])for(const container of ['wav','aiff','raw'] as const){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),2000*2));
      const input=source==='raw'?['-f',raw,'-ar','44100','-ac','2']:[];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','44100','-ac','2','-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      await compare(root,frontend,`input.${source}`,['-cpuflags','0',...input],['-af','adynamicsmooth=2:1000','-c:a',container==='aiff'?'pcm_s16be':codec,'-bitexact','-f',container==='raw'?raw:container],`${raw}/${source}/${container}`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails explicitly before output for native errors, unimplemented option forms, timeline enable and rate conversion',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adynamicsmooth-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));
    const run=async(args:string[])=>{const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-f','framecrc','-']).status};};
    for(const [chain,nativeAccepts]of [
      // Native rejects these too.
      ['adynamicsmooth=-1',false],['adynamicsmooth=1000001',false],['adynamicsmooth=basefreq=1',false],['adynamicsmooth=2:2000000',false],['adynamicsmooth=1:2:3',false],['adynamicsmooth=foo=1',false],['adynamicsmooth=abc',false],['adynamicsmooth=s=2',false],
      // Native accepts these; they stay unimplemented and are not approximated.
      ['adynamicsmooth=1e3',true],['adynamicsmooth=basefreq=1k',true],['adynamicsmooth=basefreq=0x100',true],['adynamicsmooth=enable=1',true],['adynamicsmooth=enable=gte(t\\,0.001)',true]
    ] as const){
      const {result,out,nativeStatus}=await run(['-af',chain]);
      expect(nativeStatus===0,chain).toBe(nativeAccepts);expect(result.exitCode,chain).not.toBe(0);expect(result.diagnostics.at(-1)?.message,chain).toMatch(/adynamicsmooth/);expect(existsSync(join(root,out.slice(1))),chain).toBe(false);
    }
    const {result,out,nativeStatus}=await run(['-af','adynamicsmooth','-ar','16000']);
    expect(nativeStatus).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toMatch(/adynamicsmooth with sample rate conversion is not implemented/);expect(existsSync(join(root,out.slice(1)))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
