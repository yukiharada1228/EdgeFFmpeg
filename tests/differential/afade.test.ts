import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),linux64=process.platform==='linux'&&process.arch==='x64';
const formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
const curves=['tri','qua','cub','squ','par','ipar','desi','quat','nofade'] as const;
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=65536){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  for(const [raw,,width]of formats)writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),700*2));
  const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}});
  let index=0;const counts={compared:0,refused:0};
  /** Native bytes and Edge bytes for one stereo 8000 Hz input; -cpuflags 0 keeps native's float-to-integer conversion scalar. */
  async function compare(raw:string,before:readonly string[],after:readonly string[],format:string){
    const head=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2',...before],tail=[...after,'-bitexact','-f',format],nativeOut=join(root,'native.out');execFileSync(native,['-v','error',...head,'-i',join(root,`${raw}.raw`),...tail,'-y',nativeOut]);const expected=readFileSync(nativeOut),out=`/${index++}.out`,result=await frontend.exec([...head,'-i',`/${raw}.raw`,...tail,out]);
    expect(result.exitCode,JSON.stringify({raw,before,after,format,diagnostics:result.diagnostics})).toBe(0);
    expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw} ${before.join(' ')} ${after.join(' ')} ${format}`).toBe(true);counts.compared++;
  }
  /** Edge refuses with `message` and opens nothing; returns native's exit status for the same command. */
  async function refuse(raw:string,filter:string,message:RegExp,output:readonly string[]=['-f','s16le']){
    const head=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],tail=['-af',filter,...output,...(output.includes('-f')?[]:['-f',output.includes('-c:a')?'wav':'s16le'])],nativeStatus=spawnSync(native,['-v','error',...head,'-i',join(root,`${raw}.raw`),...tail,'-y',join(root,'native.out')]).status,out=`/${index++}.out`,result=await frontend.exec([...head,'-i',`/${raw}.raw`,...tail,out]);
    expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics.at(-1)?.message,filter).toMatch(message);expect(existsSync(join(root,out.slice(1))),filter).toBe(false);
    counts.refused++;return nativeStatus;
  }
  return {root,compare,refuse,counts};
}
/** Whether afade works in a floating format: the source format when listed, else (u8) the encoder's. */
const floating=(raw:string,codec:string)=>raw.startsWith('f')||(raw==='u8'&&codec==='pcm_f32le');
const boundary=/afade with silence=0 on (flt|dbl) samples outside the fade depends on native frame boundaries/;
/** ipar's 1 - (1 - gain) * (1 - gain) is fused by the macOS arm64 reference build, so every ipar case runs only on linux/x64. */
const platformCurves=curves.filter(curve=>curve!=='ipar');
type Harness=Awaited<ReturnType<typeof harness>>;
async function curveCases({compare,refuse}:Harness,curve:typeof curves[number]){
  for(const type of ['in','out']){
    for(const spelling of [`t=${type}:ss=150:ns=301:c=${curve}`,`type=${type}:start_sample=150:nb_samples=301:curve=${curve}`,`${type}:st=0.01875:d=0.037625:curve=${curve}`,`${type}:150:301:c=${curve}`])if(curve==='nofade')expect(await refuse('s16le',`afade=${spelling}`,/afade nofade with silence outside the fade/),spelling).toBe(0);
    else for(const [raw,codec]of [['s16le','pcm_s16le'],['s32le','pcm_s32le'],['s16le','pcm_u8']] as const)await compare(raw,[],['-af',`afade=${spelling}`,'-c:a',codec],codec==='pcm_u8'?'u8':raw);
    // A fade-in from sample 0 has no samples before its window, so it runs on floating samples too.
    if(type==='in')for(const zero of [`t=in:ss=0:ns=301:c=${curve}`,`in:d=0.037625:c=${curve}`,`c=${curve}:ns=1`,`in:0:100000:0:0:${curve}`])for(const [raw,codec]of [['f32le','pcm_f32le'],['f64le','pcm_f64le'],['s16le','pcm_s16le']] as const)await compare(raw,[],['-af',`afade=${zero}`,'-c:a',codec],raw);
  }
}
async function formatCases({compare,refuse}:Harness,fades:readonly string[],windows:readonly string[]){
  for(const [raw]of formats)for(const codec of ['pcm_u8','pcm_s16le','pcm_f32le'])for(const container of ['wav','framecrc']){
    for(const filter of fades)await compare(raw,[],['-af',filter,'-c:a',codec],container);
    for(const filter of windows){
      if(floating(raw,codec))expect(await refuse(raw,filter,boundary,['-c:a',codec,'-f',container]),filter).toBe(0);
      else await compare(raw,[],['-af',filter,'-c:a',codec],container);
    }
  }
}
const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.01'],[]],[['-ss','0.005','-t','0.05'],[]],[[],['-ss','0.02']],[[],['-t','0.03']],[[],['-ss','0.01','-t','0.04']],[[],['-frames:a','3']]];
/** [chain, runs on floating samples] under every input and output time selection profile. */
async function timeCases({compare}:Harness,chains:readonly [string,boolean][]){
  for(const [chain,float]of chains)for(const [before,after]of profiles)for(const [raw,codec]of float?[['s16le','pcm_s16le'],['f64le','pcm_f64le']] as const:[['s16le','pcm_s16le'],['s32le','pcm_s32le']] as const)await compare(raw,before,[...after,'-af',chain,'-c:a',codec],'framecrc');
}
it('matches native fade-in and fade-out bytes for every implemented curve and the ss/ns, st/d and positional spellings',async()=>{
  const context=await harness('edgeffmpeg-afade-curves-'),{root,counts}=context;
  try{
    for(const curve of platformCurves)await curveCases(context,curve);
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native WAV and framecrc output from every source format into u8, s16 and f32 outputs',async()=>{
  const context=await harness('edgeffmpeg-afade-formats-'),{root,counts}=context;
  try{
    await formatCases(context,['afade=ns=400','afade=in:ns=1:c=squ','afade=st=0:d=0.05:c=desi'],['afade=ss=100:ns=400','afade=out:st=0.05:d=0.01:c=desi']);
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native fades crossing frame boundaries, outside the input, and under input and output time selection',async()=>{
  const context=await harness('edgeffmpeg-afade-time-'),{root,counts}=context;
  const chains:[string,boolean][]=[['asetnsamples=37:p=0,afade=ss=100:ns=250:c=cub',false],['asetnsamples=37,afade=t=out:ss=111:ns=73:c=par',false],['asetnsamples=64:p=0,afade=t=out:ss=0:ns=1',false],['afade=ss=5000:ns=10',false],['afade=t=out:ss=5000:ns=10',false],['afade=ss=0:ns=100000',true],['afade=t=out:ss=0:ns=100000:c=qua',false],['afade=c=nofade',true],['afade',true],['afade=t=out',false],['afade=st=1:d=0.01',false],['asetnsamples=50:p=0,afade=in:ns=350:c=quat,asetnsamples=7',true],['asetnsamples=29,afade=in:ns=333:c=desi',true],['afade=t=out:ss=90:ns=200,volume=0.5:precision=fixed',false],['asetrate=16000,afade=st=0.01:d=0.02',false],['asetrate=16000,afade=d=0.02:c=squ',true],['afade=ss=600:ns=99,afade=t=out:ss=0:ns=650:c=desi',false]];
  try{
    await timeCases(context,chains);
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},240000);
it.runIf(linux64)('matches native ipar fades on linux x64 for every spelling, source format, output and time selection',async()=>{
  // Every ipar case of the three tests above. The macOS arm64 reference fuses 1 - (1 - gain) * (1 - gain) (78 of 302 gains
  // differ for ns=301), while EdgeFFmpeg follows the unfused linux/x64 profile.
  const context=await harness('edgeffmpeg-afade-ipar-'),{root,counts}=context;
  try{
    await curveCases(context,'ipar');
    await formatCases(context,['afade=ns=650:c=ipar'],['afade=t=out:ss=200:ns=333:c=ipar']);
    await timeCases(context,[['afade=ns=400,afade=ns=17:c=ipar',true]]);
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},240000);
it.runIf(linux64)('matches native non-default silence and unity gains on linux x64',async()=>{
  const {root,compare,refuse,counts}=await harness('edgeffmpeg-afade-gain-');
  try{
    for(const curve of curves)for(const type of ['in','out'])for(const gains of ['silence=0.1:unity=0.9','silence=0.25','unity=0.5','silence=1:unity=0','silence=0.3:unity=0.3','silence=0.05:unity=0.95'])for(const [raw,codec]of [['s16le','pcm_s16le'],['s32le','pcm_s32le'],['f32le','pcm_f32le'],['f64le','pcm_f64le']] as const){
      const filter=`asetnsamples=97:p=0,afade=t=${type}:ss=200:ns=500:c=${curve}:${gains}`;
      if(curve==='nofade'&&!gains.startsWith('silence=0.3'))expect(await refuse(raw,filter,/afade nofade with silence outside the fade/),filter).toBe(0);
      else if(gains==='unity=0.5'&&!codec.endsWith('s16le')&&!codec.endsWith('s32le'))expect(await refuse(raw,filter,boundary,['-c:a',codec]),filter).toBe(0);
      else await compare(raw,[],['-af',filter,'-c:a',codec],'framecrc');
    }
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},240000);
it('refuses libm curves, unimplemented syntax and frame-boundary-dependent fades before output, recording native status',async()=>{
  const {root,refuse,counts}=await harness('edgeffmpeg-afade-refuse-');
  try{
    // Native implements every libm curve; Edge refuses because sin/cos/exp/log10/cbrt/pow results are not reproduced.
    for(const curve of ['qsin','esin','hsin','log','cbr','exp','iqsin','ihsin','dese','losi','sinc','isinc','quatr','qsin2','hsin2'])expect(await refuse('s16le',`afade=c=${curve}`,/afade curve .* requires unimplemented libm functions/),curve).toBe(0);
    for(const [filter,nativeAccepts] of [['afade=ns=0',false],['afade=t=sideways',false],['afade=silence=2',false],['afade=st=-1',false],['afade=foo=1',false],['afade=ss=5:in',false],['afade=c=7',true],['afade=t=in+out',true],['afade=ss=1e2',true],['afade=enable=gte(t\\,0.01)',true],['afade=d=1us',true],['afade=ss=9007199254740993',true],['afade=silence=0.2:unity=0.9',true],['afade=ss=10:c=nofade',true],['afade=t=out:c=nofade:unity=0.5',true]] as const)expect(await refuse('s16le',filter,/afade/)===0,filter).toBe(nativeAccepts);
    for(const [raw,filter]of [['f32le','afade=t=out'],['f64le','afade=ss=1:ns=5'],['f32le','afade=st=0.001:c=ipar'],['u8','afade=t=out:ss=0:ns=1']] as const)expect(await refuse(raw,filter,boundary,raw==='u8'?['-c:a','pcm_f32le']:[]),filter).toBe(0);
  }finally{console.info('afade native comparisons',JSON.stringify(counts));rmSync(root,{recursive:true,force:true});}
},120000);
