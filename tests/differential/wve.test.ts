import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
// libavformat/wvedec.c: 18-byte magic, rb32 duration, 00 00 00 01 and six zero bytes, then A-law to EOF.
function wve(dataBytes:number,duration:number):Uint8Array{
  const bytes=new Uint8Array(32+dataBytes),view=new DataView(bytes.buffer);bytes.set([...'ALawSoundFile**'].map(c=>c.charCodeAt(0)));bytes.set([0,0o17,0o20],15);view.setUint32(18,duration,false);bytes[25]=1;
  for(let i=0;i<dataBytes;i++)bytes[32+i]=(i*37+11)&255;return bytes;
}
const lengths=[0,1,511,512,513,3000,8001],durations=(length:number)=>[['equal',length],['100',100],['0',0],['larger',length+4000]] as const;
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}})};}
it('matches native WVE copy framecrc, decode to WAV AU and s16le, and A-law remux for seven data lengths and four header durations',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-wve-');
  try{
    for(const length of lengths)for(const [label,duration]of durations(length)){
      const name=`${length}-${label}`;writeFileSync(join(root,`${name}.wve`),wve(length,duration));
      const outputs=[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['dec.crc',['-bitexact','-f','framecrc']],['s16.raw',['-f','s16le']],['out.wav',['-bitexact','-f','wav']],['out.au',['-bitexact','-f','au']],['remux.alaw',['-c:a','copy','-f','alaw']]] as const;
      for(const [suffix,tail]of outputs){
        const out=`${name}-${suffix}`,expected=join(root,`native-${out}`);execFileSync(native,['-v','error','-cpuflags','0','-i',join(root,`${name}.wve`),...tail,expected]);
        const result=await ffmpeg.exec(['-cpuflags','0','-i',`/${name}.wve`,...tail,`/${out}`]);expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out)).equals(readFileSync(expected)),out).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native WVE output -ss -t and -frames:a, input -ss with an exact header duration, and forced -f wve over an altered magic',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-wve-time-');
  try{
    const profiles=[{before:[],after:['-ss','0.01','-t','0.05']},{before:[],after:['-frames:a','2']},{before:[],after:['-t','0.0641']},{before:['-ss','0.000125'],after:[]},{before:['-ss','0.1'],after:['-t','0.03']}];
    for(const length of [513,3000,8001])for(const [label,duration]of durations(length))for(const [index,profile]of profiles.entries())for(const copy of [true,false]){
      if(profile.before.length&&(label!=='equal'||Number(profile.before[1])*8000>=length))continue;
      const name=`${length}-${label}`;writeFileSync(join(root,`${name}.wve`),wve(length,duration));
      const args=['-cpuflags','0',...profile.before],tail=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed','-c:a','pcm_s16le']),'-bitexact','-f','framecrc'];
      const expected=execFileSync(native,['-v','error',...args,'-i',join(root,`${name}.wve`),...tail,'-']),out=`/${name}-${index}-${copy}.crc`,result=await ffmpeg.exec([...args,'-i',`/${name}.wve`,...tail,out]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),out).toBe(true);
    }
    const altered=wve(700,700);altered[3]=((altered[3]??0)^1);altered[23]=1;writeFileSync(join(root,'forced.wve'),altered);
    const expected=execFileSync(native,['-v','error','-f','wve','-i',join(root,'forced.wve'),'-f','s16le','-']),result=await ffmpeg.exec(['-f','wve','-i','/forced.wve','-f','s16le','/forced.raw']);
    expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,'forced.raw')).equals(expected)).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails detection like native for an altered magic byte or a nonzero byte 23 and refuses the unmirrored seek and truncated header',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-wve-refuse-');
  try{
    const negatives:Array<[string,Uint8Array]>=[];for(const index of [0,5,14,15,16,17]){const bytes=wve(600,600);bytes[index]=((bytes[index]??0)^1);negatives.push([`magic${index}`,bytes]);}
    for(const index of [22,23,24,25,26,31]){const bytes=wve(600,600);bytes[index]=((bytes[index]??0)^(index===23?7:1));negatives.push([`fixed${index}`,bytes]);}
    for(const [name,bytes]of negatives){
      writeFileSync(join(root,`${name}.wve`),bytes);
      const run=spawnSync(native,['-v','error','-i',join(root,`${name}.wve`),'-f','s16le',join(root,`native-${name}.raw`)]);expect(run.status,name).toBe(183);
      const result=await ffmpeg.exec(['-i',`/${name}.wve`,'-f','s16le',`/${name}.raw`]);// Shared detect.ts fails with a plain Error (exit 1) where native exits 183; the status gap is recorded in docs/contributing/wve-support.md.
      expect([result.exitCode,result.diagnostics.at(-1)?.message],name).toEqual([1,'Unsupported audio container signature']);expect(existsSync(join(root,`${name}.raw`))).toBe(false);
    }
    // Header durations other than the data length: native's seek was not mirrored, so input -ss is refused before output.
    for(const duration of [100,0,7000]){
      writeFileSync(join(root,'mismatch.wve'),wve(3000,duration));
      const result=await ffmpeg.exec(['-ss','0.1','-i','/mismatch.wve','-f','s16le','/mismatch.raw']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toContain('header duration');expect(existsSync(join(root,'mismatch.raw'))).toBe(false);
    }
    // Native demuxes a 26..31-byte file from a zero-padded probe; Edge refuses the truncated header.
    for(const size of [26,31]){
      writeFileSync(join(root,`short${size}.wve`),wve(0,0).subarray(0,size));expect(spawnSync(native,['-v','error','-i',join(root,`short${size}.wve`),'-f','s16le','-']).status).toBe(0);
      const result=await ffmpeg.exec(['-i',`/short${size}.wve`,'-f','s16le',`/short${size}.raw`]);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe('Truncated WVE header');expect(existsSync(join(root,`short${size}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
