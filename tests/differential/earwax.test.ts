import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4]] as const;
/** Deterministic stereo PCM: integer formats mix a loud sine with every byte pattern (so the FIR and mix clip), float stays finite in [-1,1] and includes -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){
    if(floating){const value=i===0?-0:Math.sin(i*0.0731)*((i%17)/16);view.setFloat32(i*4,value,true);continue;}
    const loud=Math.round(Math.sin(i*0.05)*(i%3===0?1:0.4)*127);
    for(let b=0;b<width;b++)view.setUint8(i*width+b,b===width-1?(width===1?loud+128:loud)&255:(i*73+b*151+37)&255);
  }
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
it('matches native WAV, raw and framecrc bytes for stereo 44100 Hz u8, s16, s32 and f32 sources and composed chains',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-earwax-');
  const chains=['earwax','asetnsamples=5,earwax','asetnsamples=31:p=0,earwax','asetnsamples=33,earwax,asetnsamples=7','earwax,apad=pad_len=9','volume=0.5,earwax','earwax,earwax','anull,earwax,volume=2'];
  const outputs=[['-c:a','pcm_s16le','-f','wav'],['-c:a','pcm_s32le','-f','wav'],['-f','s16le'],['-c:a','pcm_s16le','-f','framecrc'],['-c:a','pcm_s32le','-f','framecrc']];
  let compared=0;
  try{
    for(const [raw,width]of sources){
      writeFileSync(join(root,'input.raw'),pcm(width,raw==='f32le',5003*2));
      for(const chain of chains)for(const output of outputs){
        // Native writes to a seekable file, so WAV headers carry the final sizes.
        const before=['-cpuflags','0','-f',raw,'-ar','44100','-ac','2'],after=['-af',chain,...output,'-bitexact'],out=`/${compared}.out`,reference=join(root,`native-${compared}.out`);
        execFileSync(native,['-v','error','-y',...before,'-i',join(root,'input.raw'),...after,reference]);const expected=readFileSync(reference);
        const result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,chain,output,diagnostics:result.diagnostics})).toBe(0);
        expect(Buffer.from(readFileSync(join(root,out.slice(1)))).equals(expected),`${raw}/${chain}/${output.join(' ')}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(160);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native output time selection and frame limits after the cross-frame history',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-earwax-time-');
  const profiles:[string[],string[]][]=[[['-ss','0.01'],[]],[['-t','0.05'],[]],[[],['-ss','0.03']],[[],['-t','0.02']],[[],['-ss','0.01','-to','0.07']],[[],['-frames:a','2']]];
  let compared=0;
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,5003*2));
    for(const chain of ['earwax','asetnsamples=5,earwax'])for(const [input,output]of profiles){
      const before=['-f','s16le','-ar','44100','-ac','2',...input],after=['-af',chain,...output,'-c:a','pcm_s16le','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${compared}.crc`;
      const result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
      expect(result.exitCode,JSON.stringify({chain,input,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),`${chain}/${input.join(' ')}/${output.join(' ')}`).toBe(expected.toString());compared++;
    }
    expect(compared).toBe(12);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses mono, three-channel and 48000 Hz input before output where native converts implicitly, and refuses options native rejects',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-earwax-refuse-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,600*3));
    for(const [rate,channels]of [[44100,1],[44100,3],[48000,2],[8000,1]] as const){
      const before=['-f','s16le','-ar',String(rate),'-ac',String(channels)],after=['-af','earwax','-c:a','pcm_s16le','-f','wav'];
      // Native inserts aresample (and a remix) for these inputs and succeeds.
      const reference=spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-'],{encoding:'buffer'});
      expect(reference.status,`${rate}/${channels}`).toBe(0);expect(reference.stdout.length).toBeGreaterThan(44);
      const result=await frontend.exec([...before,'-i','/input.raw',...after,'/refused.wav']);
      expect(result.exitCode,`${rate}/${channels}`).not.toBe(0);expect(result.diagnostics[0]?.message).toBe('earwax requires stereo 44100 Hz input');
      expect(existsSync(join(root,'refused.wav'))).toBe(false);
    }
    for(const chain of ['earwax=1','earwax=enable=1']){
      const before=['-f','s16le','-ar','44100','-ac','2'],after=['-af',chain,'-c:a','pcm_s16le','-f','wav'];
      expect(spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']).status,chain).not.toBe(0);
      const result=await frontend.exec([...before,'-i','/input.raw',...after,'/option.wav']);
      expect(result.exitCode,chain).not.toBe(0);expect(result.diagnostics[0]?.message).toBe('Unsupported earwax option');expect(existsSync(join(root,'option.wav'))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
