import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {arch,platform,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),linux=platform()==='linux'&&arch()==='x64';
const formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
/** Deterministic PCM: integer formats mix every byte pattern with runs of full-scale extremes that force wrap; floating formats stay finite in [-1,1], with -0 and ±1 steps. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){
    const extreme=i%11<4?(i%2?1:-1):0;
    if(!floating){if(extreme)for(let b=0;b<width;b++)view.setUint8(i*width+b,b===width-1?(extreme>0?(width===1?255:127):(width===1?0:128)):(extreme>0?255:0));else for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);}
    else{const value=i===0?-0:extreme?extreme:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
  }
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:30000}})};
}
const chains=['aderivative','asetnsamples=7,aderivative','aderivative,apad=pad_len=5','aderivative,aderivative'];
it('matches native framecrc across source formats, channel counts, frame splits and padding in the native format and s16',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aderivative-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2,3]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),20000*channels));
      for(const target of codec==='pcm_s16le'?[codec]:[codec,'pcm_s16le'])for(const chain of chains){
        if(raw.startsWith('f')&&target==='pcm_s16le'&&!linux)continue;
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-'],{maxBuffer:1<<26}),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('writes native-identical WAV and raw PCM from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aderivative-files-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const chain of ['aderivative','asetnsamples=7,aderivative'])for(const source of ['raw','wav'])for(const container of ['wav','raw'] as const)for(const target of codec==='pcm_s16le'?[codec]:[codec,'pcm_s16le']){
      if(raw.startsWith('f')&&target==='pcm_s16le'&&!linux)continue;
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),20000*2));
      const input=source==='raw'?['-f',raw,'-ar','8000','-ac','2','-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      const name=`/${index++}.${container==='raw'?'pcm':container}`,reference=join(root,`reference${name.slice(1)}`),after=['-af',chain,'-c:a',target,'-bitexact','-f',container==='raw'?(target==='pcm_s16le'?'s16le':raw):container];
      execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,reference]);
      const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,name]);
      expect(result.exitCode,JSON.stringify({raw,chain,source,container,target,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${chain}/${source}/${container}/${target}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('filters the whole input before output -ss, -t, -to and -frames:a, as native does',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aderivative-time-');
  const profiles=[['-ss','0.5'],['-t','0.3'],['-ss','1.1','-t','0.4'],['-ss','0.25','-to','2'],['-frames:a','3'],['-frames:a','1'],['-ss','2.4','-frames:a','2'],['-t','0.00001']];
  try{
    let index=0;
    for(const [raw,codec,width]of [formats[0],formats[1],formats[2],formats[4]])for(const channels of [1,2])for(const chain of ['aderivative','asetnsamples=7,aderivative','aderivative,apad=pad_len=5'])for(const output of profiles){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),20000*channels));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,channels,chain,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${chain}/${output.join(' ')}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native where neighbouring format lists merge with its own, across source formats',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aderivative-merge-');
  // aformat=s16p after it merges into its list, so native differences float input at s16p and wraps; volume beside it merges {flt,fltp} or keeps the encoder out.
  const neighbours=['aderivative,aformat=s16p','aformat=s16p,aderivative','aformat=s16,aderivative','aderivative,aformat=s16','aderivative,aformat=fltp','aderivative,volume=0.5','volume=0.5,aderivative','aderivative,volume=0.5:precision=fixed','aformat=dbl,aderivative,aformat=s32'];
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2]){
      if(raw.startsWith('f')&&!linux)continue;
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),20000*channels));
      for(const target of codec==='pcm_s16le'?[codec]:[codec,'pcm_s16le'])for(const chain of neighbours){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-'],{maxBuffer:1<<26}),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('fails explicitly before output for options, timeline enable and neighbour merges native would run in another format',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aderivative-errors-');
  try{
    writeFileSync(join(root,'s16.raw'),pcm(2,false,64*2));writeFileSync(join(root,'flt.raw'),pcm(4,true,64*2));let index=0;
    const run=async(input:string,raw:string,args:string[])=>{const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${input}`,...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,input),...args,'-f','framecrc','-']).status};};
    // Native rejects these too.
    for(const chain of ['aderivative=1','aderivative=foo=1']){const {result,out,nativeStatus}=await run('s16.raw','s16le',['-af',chain]);expect(nativeStatus,chain).not.toBe(0);expect(result.exitCode,chain).not.toBe(0);expect(existsSync(join(root,out.slice(1))),chain).toBe(false);}
    // Native accepts these; they stay unimplemented.
    for(const [input,raw,args]of [['s16.raw','s16le',['-af','aderivative=']],['s16.raw','s16le',['-af','aderivative=enable=1']],['s16.raw','s16le',['-af','aderivative=enable=gte(t\\,0.001)']],['s16.raw','s16le',['-af','aderivative','-ar','16000']],['flt.raw','f32le',['-af','volume=0.5:precision=fixed,aderivative','-c:a','pcm_s16le']],['flt.raw','f32le',['-af','volume=0.5:precision=fixed,aderivative,anull','-c:a','pcm_s16le']]] as const){
      const {result,out,nativeStatus}=await run(input,raw,[...args]);expect(nativeStatus,args.join(' ')).toBe(0);expect(result.exitCode,args.join(' ')).not.toBe(0);expect(result.diagnostics.at(-1)?.message,args.join(' ')).toMatch(/aderivative/);expect(existsSync(join(root,out.slice(1))),args.join(' ')).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
