import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** Float sums are IEEE additions only, but the pinned evidence is the Linux x86_64 reference build. */
const linux=process.platform==='linux'&&process.arch==='x64';
const sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
const count=301,channels=2;
/** Interleaved stereo fixture: `low` is a zero-mean, low-amplitude sine/cosine pair (period 40 and 24) whose running sum stays within +-1; otherwise wide pseudo-random samples. */
function fixture(raw:string,width:number,low:boolean){
  const data=new Uint8Array(count*channels*width),view=new DataView(data.buffer);
  for(let i=0;i<count*channels;i++){
    const n=Math.floor(i/channels),value=low?(i%channels===0?Math.sin(2*Math.PI*n/40):Math.cos(2*Math.PI*n/24))*0.05:Math.sin(i*0.123)*0.6+(((i*7919+13)%1009)/1009-0.5)*0.7;
    if(raw==='u8')view.setUint8(i*width,128+Math.round(value*127));
    else if(raw==='s16le')view.setInt16(i*width,Math.round(value*32767),true);
    else if(raw==='s32le')view.setInt32(i*width,Math.round(value*2147483647),true);
    else if(raw==='f32le')view.setFloat32(i*width,value,true);
    else view.setFloat64(i*width,value,true);
  }
  return data;
}
async function frontend(root:string,budget=4096){
  return new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget}),backend:createMediaBackend(),budget:{maxResidentBytes:1<<21,maxBufferBytes:budget,maxCpuTimeMs:5000,maxPendingPackets:2}});
}
const chains=['aintegral','asetnsamples=7,aintegral','aintegral,asetnsamples=11:p=0','asetnsamples=1,aintegral,asetnsamples=13','asetnsamples=16:p=0,aintegral,aintegral'];
const scenarios=[{input:[],output:[]},{input:[],output:['-ss','0.005']},{input:[],output:['-t','0.02']},{input:[],output:['-ss','0.004','-t','0.011']},{input:[],output:['-ss','0.002','-frames:a','3']},{input:['-ss','0.001','-t','0.03'],output:[]}];
let comparisons=0;
async function compare(ffmpeg:FFmpeg,root:string,source:string,raw:string,filter:string,scenario:{input:readonly string[];output:readonly string[]},codec:string,container:string,cpuflags:boolean,label:string){
  const args=[...(cpuflags?['-cpuflags','0']:[]),'-f',raw,'-ar','8000','-ac','2',...scenario.input],outputArgs=[...scenario.output,'-af',filter,'-c:a',codec,'-bitexact','-f',container];
  // Native writes a seekable file, so WAV headers carry final sizes on both sides.
  const name=label.replace(/[^a-z0-9]+/gi,'-'),reference=join(root,`${name}.native`),expected=spawnSync(native,['-v','error','-y',...args,'-i',join(root,source),...outputArgs,reference],{timeout:30000});
  expect(expected.status,`${label} native ${expected.stderr}`).toBe(0);
  const output=`/${name}.out`,result=await ffmpeg.exec([...args,'-i',`/${source}`,...outputArgs,output]);
  expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(0);
  expect(readFileSync(join(root,output.slice(1))).equals(readFileSync(reference)),label).toBe(true);comparisons++;
}
it.runIf(linux)('matches native aintegral f32 and f64 output for every source format, frame split and output time selection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aintegral-'));
  try{
    const frontends=[await frontend(root,256),await frontend(root,4096)];
    for(const [raw,width]of sources){
      writeFileSync(join(root,`${raw}.raw`),fixture(raw,width,false));
      for(const [chainIndex,filter]of chains.entries())for(const [index,scenario]of scenarios.entries())for(const [codec,container]of [['pcm_f32le','f32le'],['pcm_f64le','f64le'],['pcm_f32le','framecrc'],['pcm_f64le','framecrc']] as const){
        if(container==='framecrc'&&index!==0&&index!==3)continue;
        for(const [budget,ffmpeg]of frontends.entries())await compare(ffmpeg,root,`${raw}.raw`,raw,filter,scenario,codec,container,false,`${raw}-${chainIndex}-${index}-${codec}-${container}-${budget}`);
      }
    }
    expect(comparisons).toBe(sources.length*chains.length*(scenarios.length*2+4)*2);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native aintegral s16 output with -cpuflags 0 from low-amplitude zero-mean input whose integral stays within one',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aintegral-s16-'));
  try{
    const ffmpeg=await frontend(root);
    for(const [raw,width]of sources){
      const data=fixture(raw,width,true);writeFileSync(join(root,`${raw}-low.raw`),data);
      for(const [chainIndex,filter]of chains.slice(0,4).entries())for(const [index,scenario]of scenarios.entries())for(const container of ['s16le','framecrc','wav'])
        await compare(ffmpeg,root,`${raw}-low.raw`,raw,filter,scenario,'pcm_s16le',container,true,`low-${raw}-${chainIndex}-${index}-${container}`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('refuses aintegral options, timeline enable, and integer output beyond the scalar conversion bound before writing output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aintegral-refusal-'));
  try{
    const ffmpeg=await frontend(root);
    const wide=new Uint8Array(count*channels*4),view=new DataView(wide.buffer);for(let i=0;i<count*channels;i++)view.setFloat32(i*4,0.5,true);writeFileSync(join(root,'wide.raw'),wide);
    const big=new Uint8Array(70000*4),bigView=new DataView(big.buffer);for(let i=0;i<70000;i++)bigView.setFloat32(i*4,1,true);writeFileSync(join(root,'big.raw'),big);
    const cases:[string,readonly string[],readonly string[],string][]=[
      ['options',['-f','f32le','-ar','8000','-ac','2','-i','wide.raw'],['-af','aintegral=foo=1','-f','f32le'],'aintegral accepts no options'],
      ['enable',['-f','f32le','-ar','8000','-ac','2','-i','wide.raw'],['-af','aintegral=enable=1','-f','f32le'],'aintegral timeline enable is not implemented'],
      ['bound',['-cpuflags','0','-f','f32le','-ar','8000','-ac','1','-i','big.raw'],['-af','aintegral','-f','s16le'],'Non-finite or out-of-range floating PCM requires an unimplemented runtime conversion profile']
    ];
    const statuses:Record<string,number|null>={};
    for(const [label,input,output,message]of cases){
      const nativeResult=spawnSync(native,['-v','error',...input.map(arg=>arg.endsWith('.raw')?join(root,arg):arg),...output,'-'],{timeout:30000});statuses[label]=nativeResult.status;
      const target=`/${label}.out`,result=await ffmpeg.exec([...input.map(arg=>arg.endsWith('.raw')?`/${arg}`:arg),...output,target]);
      expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toContain(message);
      expect(existsSync(join(root,target.slice(1)))&&readFileSync(join(root,target.slice(1))).length>0,label).toBe(false);
    }
    // Native rejects the unknown option (exit 8, 'Option not found'), but accepts timeline enable and clips the out-of-range integral into s16.
    expect(statuses).toEqual({options:8,enable:0,bound:0});
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
