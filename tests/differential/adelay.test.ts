import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {referenceRemixArithmetic} from '../helpers/remix-profile.js';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=65536,backend=createMediaBackend()){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,filesystem,frontend:new FFmpeg({filesystem,backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}})};
}
it('matches native framecrc bytes and timestamps across formats, channel counts, delay lists and composed chains',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-');
  const chains=['adelay=10S','adelay=700S|1300S|3S','adelay=1300S|700S:all=1','adelay=delays=2|0.5:all=true','adelay=2100S|2100S|2100S','adelay=0S|5S|2049S','adelay=9S|2S,asetnsamples=5:p=0','asetnsamples=500,adelay=9S|602S','apad=pad_len=10:packet_size=7,adelay=9S|2S','adelay=9S|2S,apad=pad_len=2500','volume=0.5:precision=fixed,adelay=4S|1S','adelay=4S|600S,volume=0.37:precision=fixed','adelay=4S|1S,volume=0.25:precision=double','asetrate=16000,adelay=1|0.5','aformat=s32p,adelay=3S|700S','aformat=dblp,adelay=3S|5S,aformat=s16','adelay=5S,adelay=0|7S','adelay','adelay=0S|0S','adelay=all=1'];
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2,3]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      for(const target of codec==='pcm_s16le'?[codec]:[codec,'pcm_s16le'])for(const chain of chains){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native input/output time selection and frame limits over leading silence, delayed input and flush sections',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-time-');
  const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.02'],[]],[['-t','0.05'],[]],[['-ss','0.1','-t','0.02'],['-ss','0.001','-t','0.3']],[[],['-ss','0.05']],[[],['-ss','0.3']],[[],['-t','0.1']],[[],['-ss','0.03','-to','0.2']],[[],['-frames:a','3']],[[],['-frames:a','1']],[[],['-t','0.00001']],[[],['-ss','0.26','-frames:a','2']]];
  const chains=['adelay=700S|1300S','adelay=2100S|30S:all=1','adelay=9S|2S,asetnsamples=5:p=0','apad=pad_len=10:packet_size=7,adelay=9S|2S'];
  try{
    let index=0;
    for(const [raw,codec,width]of [formats[1],formats[4]])for(const channels of [1,2])for(const chain of chains)for(const [input,output]of profiles){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),...input],after=['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,channels,chain,input,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${chain}/${input.join(' ')}/${output.join(' ')}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native output for empty input, where only leading silence and flush remain',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-empty-');
  try{
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));let index=0;
    for(const [raw,codec]of [formats[0],formats[3]])for(const chain of ['adelay=100S|3000S','adelay=100S','adelay=3000S:all=1','adelay=0S','adelay=5S,apad=pad_len=10','adelay=100S|3000S,asetnsamples=1000'])for(const output of [[],['-t','0.01'],['-ss','0.01'],['-frames:a','2']]){
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],after=['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'empty.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/empty.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,chain,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${chain}/${output.join(' ')}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('writes native-identical WAV, AIFF and raw PCM files from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-files-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const chain of ['adelay=700S|13|3S:all=1','aformat=fltp,adelay=5S|1300S,volume=0.5'])for(const source of ['raw','wav'])for(const container of ['wav','aiff','raw'] as const){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*2));
      const input=source==='raw'?['-f',raw,'-ar','8000','-ac','2','-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      const name=`/${index++}.${container==='raw'?'pcm':container}`,reference=join(root,`reference${name.slice(1)}`),after=['-af',chain,'-c:a',container==='aiff'?'pcm_s16be':codec,'-bitexact','-f',container==='raw'?raw:container];
      execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,reference]);
      const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,name]);
      expect(result.exitCode,JSON.stringify({raw,chain,source,container,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${chain}/${source}/${container}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native float32 millisecond/second rounding, suffix fallbacks, empty fields and unread tokens',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-round-');
  // 110.839 ms at 11025 Hz and 50.839 ms at 22050 Hz truncate to 1222/1121 samples in float32 (1221/1120 exactly).
  const delays=['110.839','50.839','268.39','1.5','0.1','0.99','1.009','0.06','1.5s','1.5S','.5s','1s','2s','00.25','7.','0.0001','10||20','|3|','007S'];
  try{
    let index=0;
    for(const rate of [8000,11025,22050,44100,48000]){
      writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));
      for(const delay of delays){
        const before=['-f','s16le','-ar',String(rate),'-ac','2'],after=['-af',`adelay=${delay}:all=1`,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({rate,delay,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${rate}/${delay}`).toBe(expected.toString());
      }
    }
    // 1523 s at 11025 Hz: 16791075 is not a float32, so native truncates the even neighbour 16791076.
    writeFileSync(join(root,'mono.raw'),pcm(2,false,64));
    {const before=['-f','s16le','-ar','11025','-ac','1'],after=['-af','adelay=1523s','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'mono.raw'),...after,'-'],{maxBuffer:1<<26}),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/mono.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).toString()).toBe(expected.toString());expect(expected.toString().split('\n').filter(line=>/^0,/.test(line)).reduce((sum,line)=>sum+Number(line.split(',')[3]),0)).toBe(16791076+64);}
    // Native parses only one token per channel, so invalid trailing tokens are never read.
    writeFileSync(join(root,'mono.raw'),pcm(2,false,64));
    for(const chain of ['adelay=5S|abc|-5','adelay=delays=7S|nan:all=1']){
      const before=['-f','s16le','-ar','8000','-ac','1'],after=['-af',chain,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'mono.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/mono.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({chain,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),chain).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails explicitly before output for native errors, unimplemented delay forms and unsupported combinations',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));writeFileSync(join(root,'float.raw'),pcm(4,true,64*2));let index=0;
    const run=async(input:string,raw:string,args:string[])=>{const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${input}`,...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,input),...args,'-f','framecrc','-']).status};};
    // Native rejects these too.
    for(const delays of ['-5','abc','5S|-5','5S:all=2']){const {result,out,nativeStatus}=await run('input.raw','s16le',['-af',`adelay=${delays}`]);expect(nativeStatus,delays).not.toBe(0);expect(result.exitCode,delays).not.toBe(0);expect(existsSync(join(root,out.slice(1)))).toBe(false);}
    // Native accepts these forms; they remain unimplemented and must not be approximated.
    for(const delays of ['5ms','1e1','+5S','-0','nan','0x10','5S:all=yes','5S:1:1','delays=5S:5S','5S:foo=1','5S\\|6S']){const {result,out}=await run('input.raw','s16le',['-af',`adelay=${delays}`]);expect(result.exitCode,delays).not.toBe(0);expect(result.diagnostics.at(-1)?.message,delays).toMatch(/adelay/);expect(existsSync(join(root,out.slice(1)))).toBe(false);}
    for(const [input,raw,args]of [['input.raw','s16le',['-af','adelay=5S','-ar','16000']],['float.raw','f32le',['-af','volume=0.5:precision=fixed,adelay=5S,aformat=s16']],['float.raw','f32le',['-af','adelay=5S,volume=0.5:precision=fixed,aformat=s32p']]] as const){
      const {result,out,nativeStatus}=await run(input,raw,[...args]);expect(nativeStatus).toBe(0);expect(result.exitCode,args.join(' ')).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toMatch(/adelay/);expect(existsSync(join(root,out.slice(1)))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('keeps native output under small physical I/O budgets and rejects delay rings above the buffer budget',async()=>{
  for(const budget of [128,512]){
    const {root,frontend}=await harness('edgeffmpeg-adelay-budget-',budget);
    try{
      let index=0;
      for(const [raw,codec,width]of [formats[0],formats[1],formats[4]])for(const channels of [1,2])for(const chain of ['adelay=9S|2S','adelay=3S|5S,asetnsamples=5:p=0','aformat=dblp,adelay=4S:all=1']){
        writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),13*channels));
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({budget,raw,channels,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${budget}/${raw}/${channels}/${chain}`).toBe(expected.toString());
      }
      const result=await frontend.exec(['-f','s16le','-ar','8000','-ac','2','-i','/input.raw','-af','adelay=0S|4000S','-f','framecrc','/too-large.crc']);
      expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.code).toBe('resource-budget');expect(existsSync(join(root,'too-large.crc'))).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
},60000);
it('matches native stereo/mono channel conversion after adelay under the pinned rematrix arithmetic profile',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-adelay-remix-',65536,createMediaBackend({remixArithmetic:referenceRemixArithmetic()}));
  try{
    let index=0;
    for(const [raw,,width]of [formats[0],formats[1],formats[3]])for(const [from,to]of [[2,1],[1,2]] as const)for(const chain of ['adelay=5S|700S','aformat=fltp,adelay=9S|2S','adelay=3S|1S,volume=0.5','adelay=2100S:all=1,asetnsamples=7'])for(const codec of ['pcm_s16le','pcm_f32le']){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*from));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(from)],after=['-af',chain,'-ac',String(to),'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,from,to,chain,codec,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${from}->${to}/${chain}/${codec}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
