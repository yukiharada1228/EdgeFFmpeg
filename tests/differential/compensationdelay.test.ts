import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {arch,platform,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
// dry*x + wet*x[n-delay] in double: the reference build's unfused arithmetic was verified only on Linux x64.
const linux=platform()==='linux'&&arch()==='x64';
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,buffer=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<22,maxWriteBytes:1<<22});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<24,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
// Delay 0 (defaults), sub-frame and multi-frame delays, every option, positional shorthand, temperature extremes and composed chains.
const chains=['compensationdelay','compensationdelay=mm=7','compensationdelay=cm=33:mm=7:dry=0.3:wet=0.6','compensationdelay=m=1:temp=-50','compensationdelay=m=2:cm=5:mm=3:temp=50:dry=1:wet=1',
  'compensationdelay=m=10:cm=1:mm=9:temp=20:dry=0.3:wet=0.6','compensationdelay=5:3:1:0.3:0.6:-50','compensationdelay=m=30:mm=10:dry=1:wet=1:temp=50','asetnsamples=37:p=0,compensationdelay=cm=50:dry=0.3:wet=0.6','compensationdelay=cm=20:temp=-50,volume=0.5'];
it.runIf(linux)('matches native framecrc for distances, temperatures, dry/wet mixes, rates and source formats into f64 and s16',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-');
  try{
    let index=0;
    for(const [raw,,width]of formats)for(const rate of [8000,44100,48000])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),9000*channels));
      for(const target of ['pcm_f64le','pcm_s16le'])for(const chain of chains){
        const before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
        expect(result.exitCode,JSON.stringify({raw,rate,channels,target,chain,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${rate}/${channels}/${target}/${chain}`).toBe(expected.toString());
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('writes native-identical f64le, s16le and WAV files with the longest delay and output time selection',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-files-',1<<21);
  try{
    let index=0;
    for(const [raw,,width]of [formats[1],formats[4]])for(const chain of ['compensationdelay=m=100:cm=100:mm=10:temp=-50:dry=0.3:wet=0.6','compensationdelay=m=3:dry=1:wet=1'])for(const output of [[],['-ss','0.05'],['-t','0.1'],['-frames:a','2']])for(const [codec,container]of [['pcm_f64le','f64le'],['pcm_s16le','s16le'],['pcm_s16le','wav']]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),20000*2));
      const before=['-cpuflags','0','-f',raw,'-ar','44100','-ac','2'],after=['-af',chain,...output,'-c:a',codec!,'-bitexact','-f',container!],name=`/${index++}.out`,reference=join(root,`reference${name.slice(1)}`);
      execFileSync(native,['-v','error','-y',...before,'-i',join(root,'input.raw'),...after,reference]);
      const result=await frontend.exec([...before,'-i','/input.raw',...after,name]);
      expect(result.exitCode,JSON.stringify({raw,chain,output,codec,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${chain}/${output.join(' ')}/${container}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native delays that wrap the power-of-two ring at 25000 and 50000 Hz, with exact dry/wet copies on every platform',async()=>{
  // Native reads (w + buf_size - delay) & mask: at these rates the colder delays exceed buf_size and wrap. dry=0:wet=1, and
  // dry=1:wet=1 over non-overlapping impulses, are exact copies, so no fused arithmetic can reach the output.
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-wrap-',1<<21);
  try{
    let index=0;
    const impulses=(count:number)=>{const data=new Uint8Array(count*8),view=new DataView(data.buffer);for(let i=0;i<count;i+=1777)view.setFloat64(i*8,(i%3)-1.25,true);return data;};
    for(const rate of [25000,50000,8000])for(const channels of [1,2]){
      for(const [raw,data,target,chains]of [
        ['s16le',pcm(2,false,40000*channels),'pcm_s16le',['compensationdelay=m=100:cm=100:mm=10:temp=-50:dry=0:wet=1','compensationdelay=m=100:cm=100:mm=10:temp=-40:dry=0:wet=1','asetnsamples=997:p=0,compensationdelay=10:100:100:0:1:-45']],
        ['f64le',impulses(40000*channels),'pcm_f64le',['compensationdelay=m=100:cm=100:mm=10:temp=-50:dry=1:wet=1','compensationdelay=m=100:cm=100:mm=10:temp=-40:dry=0:wet=1']]
      ] as const){
        writeFileSync(join(root,'input.raw'),data);
        for(const chain of chains){
          const before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
          expect(result.exitCode,JSON.stringify({raw,rate,channels,chain,diagnostics:result.diagnostics})).toBe(0);
          expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${rate}/${channels}/${chain}`).toBe(expected.toString());
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native output for empty input',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-empty-');
  try{
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));let index=0;
    for(const chain of ['compensationdelay','compensationdelay=m=5:dry=0.3:wet=0.6']){
      const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],after=['-af',chain,'-c:a','pcm_s16le','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'empty.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/empty.raw',...after,out]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).toString(),chain).toBe(expected.toString());
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('refuses unsupported options before output, with native status for each case',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-refuse-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,400));let index=0;
    // Native rejects out-of-range values, unknown options and positional values after named ones; it accepts expressions, rounded integers and enable, which are not implemented here.
    const cases:[string,boolean][]=[['compensationdelay=mm=11',false],['compensationdelay=cm=101',false],['compensationdelay=m=-1',false],['compensationdelay=temp=-51',false],['compensationdelay=temp=51',false],['compensationdelay=dry=2',false],['compensationdelay=wet=1.5',false],['compensationdelay=foo=1',false],['compensationdelay=cm=33:7',false],
      ['compensationdelay=mm=1.5',true],['compensationdelay=dry=1e-1',true],['compensationdelay=cm=10+5',true],['compensationdelay=enable=1',true],['compensationdelay=enable=between(t\\,0\\,1)',true]];
    for(const [chain,accepted]of cases){
      const args=['-f','s16le','-ar','8000','-ac','1','-i'],after=['-af',chain,'-f','s16le'];
      expect(spawnSync(native,['-v','error',...args,join(root,'input.raw'),...after,'-y',join(root,'native.raw')]).status===0,chain).toBe(accepted);
      const out=`/${index++}.raw`,result=await frontend.exec([...args,'/input.raw',...after,out]);
      expect(result.exitCode,chain).not.toBe(0);expect(result.diagnostics.at(-1)?.code,chain).toBe('unsupported-filter');expect(existsSync(join(root,out.slice(1))),chain).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('refuses a ring beyond the buffer budget before output, where native allocates it',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-compensationdelay-budget-',65536);
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,800));
    const chain='compensationdelay=m=100:cm=100:mm=10:temp=-50',args=['-cpuflags','0','-f','s16le','-ar','48000','-ac','2','-i'],after=['-af',chain,'-f','s16le'];
    expect(spawnSync(native,['-v','error',...args,join(root,'input.raw'),...after,'-y',join(root,'native.raw')]).status).toBe(0);
    const result=await frontend.exec([...args,'/input.raw',...after,'/too-large.raw']);
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.code).toBe('resource-budget');expect(existsSync(join(root,'too-large.raw'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
