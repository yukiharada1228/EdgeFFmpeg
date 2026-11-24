import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
const chains=['acopy','acopy,acopy','asetnsamples=7,acopy','apad=pad_len=9,acopy','acopy,volume=0.5'];
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
it('matches native framecrc bytes across raw formats, channel counts, rates and composed chains',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-acopy-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2,3])for(const rate of [8000,44100]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      for(const target of codec==='pcm_s16le'?[codec]:[codec,'pcm_s16le'])for(const chain of chains){
        const before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,rate,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${rate}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native output time selection and frame limits after acopy',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-acopy-time-');
  const profiles=[['-ss','0.02'],['-t','0.05'],['-ss','0.03','-t','0.02'],['-frames:a','1'],['-frames:a','3'],['-t','0.00001'],['-ss','0.15','-frames:a','2']];
  try{
    let index=0;
    for(const [raw,codec,width]of [formats[0],formats[1],formats[4]])for(const channels of [1,2])for(const chain of chains)for(const output of profiles){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({raw,channels,chain,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${channels}/${chain}/${output.join(' ')}`).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('writes native-identical WAV, AIFF, AU and raw PCM files from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-acopy-files-');
  const containers=[['wav',null],['aiff','pcm_s16be'],['au','pcm_s16be'],['s16le','pcm_s16le'],['f32le','pcm_f32le'],['f64le','pcm_f64le']] as const;
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const channels of [1,2,3])for(const chain of ['acopy','asetnsamples=7,acopy','acopy,volume=0.5'])for(const source of ['raw','wav'])for(const [container,forced]of containers){
      // Three-channel AIFF differs from native without any filter (pre-existing AIFF muxer gap), so AIFF covers one and two channels.
      if(container==='aiff'&&channels===3)continue;
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),700*channels));
      const input=source==='raw'?['-f',raw,'-ar','44100','-ac',String(channels),'-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','44100','-ac',String(channels),'-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      const name=`/${index++}.${container}`,reference=join(root,`reference${name.slice(1)}`),after=['-af',chain,'-c:a',forced??codec,'-bitexact','-f',container];
      execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,reference]);
      const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,name]);
      expect(result.exitCode,JSON.stringify({raw,channels,chain,source,container,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${channels}/${chain}/${source}/${container}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('fails before output for acopy options, which native also refuses',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-acopy-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));
    const before=['-f','s16le','-ar','8000','-ac','2'],args=['-af','acopy=1','-f','framecrc'];
    const nativeResult=spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-']);
    expect(nativeResult.status).toBe(234);expect(nativeResult.stdout.length).toBe(0);
    const result=await frontend.exec([...before,'-i','/input.raw',...args,'/refused.crc']);
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toMatch(/acopy takes no options: acopy=1/);expect(existsSync(join(root,'refused.crc'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
