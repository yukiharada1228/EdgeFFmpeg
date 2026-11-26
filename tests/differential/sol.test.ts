import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** The sandbox-built reference at test time: commit 946fcce0 without x86 assembly; its binary hash is never pinned. */
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
// libavformat/sol.c layout: u16le magic, "SOL\0", u16le rate, u8 type, u32le size (ignored), a padding byte unless magic 0x0B8D, then PCM to EOF.
function sol(magic:number,rate:number,type:number,payload:number,seed=1):Uint8Array{
  const offset=magic===0x0b8d?13:14,bytes=new Uint8Array(offset+payload),view=new DataView(bytes.buffer);
  view.setUint16(0,magic,true);bytes.set([0x53,0x4f,0x4c,0],2);view.setUint16(6,rate,true);bytes[8]=type;view.setUint32(9,payload,true);if(offset===14)bytes[13]=0x5a;
  let x=seed*2654435761>>>0;for(let i=0;i<payload;i++){x=(x*1103515245+12345)>>>0;bytes[offset+i]=i%97<48?x>>>24:(i*13)&255;}
  return bytes;
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}})};}
const run=(args:string[])=>spawnSync(native,['-v','error',...args],{maxBuffer:1<<26});
/** [label, magic, type, codec, channels]: old and both new magics, u8 mono and stereo, s16le mono and stereo. */
const layouts=[['old-u8',0x0b8d,0,'pcm_u8',1],['old-s16bit',0x0b8d,0x14,'pcm_u8',1],['c0d-u8',0x0c0d,0,'pcm_u8',1],['c8d-u8st',0x0c8d,16,'pcm_u8',2],['c0d-s16',0x0c0d,4,'pcm_s16le',1],['c8d-s16st',0x0c8d,20,'pcm_s16le',2]] as const;
const align=(codec:string,channels:number)=>(codec==='pcm_s16le'?2:1)*channels;
it('matches native SOL copy and decode framecrc, wav, raw and au outputs for three magics, codecs, channels, rates and 4096-byte boundaries',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sol-');let compared=0;
  try{
    for(const [label,magic,type,codec,channels] of layouts)for(const rate of [8000,11025,22050])for(const frames of [-1,0,1,3*4096+7]){
      const blockAlign=align(codec,channels),payload=frames<3?4096+frames*blockAlign:frames*blockAlign,name=`${label}-${rate}-${payload}`,path=join(root,`${name}.sol`);
      writeFileSync(path,sol(magic,rate,type,payload,rate+payload));
      const raw=codec==='pcm_u8'?'u8':'s16le';
      const cases:Array<[string,string[]]>=[
        ['copy',['-c:a','copy','-bitexact','-f','framecrc']],['copy-f',['-c:a','copy','-bitexact','-f','framecrc']],['decode',['-c:a','pcm_s16le','-bitexact','-f','framecrc']],
        ['wav',['-bitexact','-f','wav']],['raw',['-c:a','copy','-f',raw]],['au',['-bitexact','-f','au']]];
      for(const [kind,tail] of cases){
        const declared=kind==='copy-f'?['-f','sol']:[],nativeOut=join(root,`${name}-${kind}.native`),expected=run([...declared,'-i',path,...tail,nativeOut]);expect(expected.status,`${name}/${kind}`).toBe(0);
        if(kind==='copy'||kind==='copy-f'){
          // Claim detection only where native's framecrc header shows the SOL stream.
          const header=readFileSync(nativeOut,'utf8');
          if(!header.includes(`#codec_id 0: ${codec}\n`)||!header.includes(`#sample_rate 0: ${rate}\n`)||!header.includes(`#channel_layout_name 0: ${channels===1?'mono':'stereo'}\n`))throw new Error(`native did not demux ${name} as SOL: ${header.slice(0,300)}`);
        }
        const out=`/${name}-${kind}.out`,result=await ffmpeg.exec([...declared,'-i',`/${name}.sol`,...tail,out]);expect(result.exitCode,`${name}/${kind} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(nativeOut)),`${name}/${kind}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(432);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native SOL output -ss, -t and -frames selections for copy and decode',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sol-time-');let compared=0;
  try{
    for(const [label,magic,type,codec,channels] of layouts)for(const rate of [8000,22050]){
      const payload=5*4096+3*align(codec,channels),name=`${label}-${rate}`,path=join(root,`${name}.sol`);writeFileSync(path,sol(magic,rate,type,payload,rate));
      const profiles=[['-ss','0.05'],['-t','0.3'],['-ss','0.13','-t','0.41'],['-ss','0.6','-t','0.2'],['-frames:a','2'],['-ss','10']];
      for(const [index,profile] of profiles.entries())for(const copy of [true,false])for(const declared of [[],['-f','sol']]){
        const tail=[...profile,...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=run([...declared,'-i',path,...tail,'-']);expect(expected.status).toBe(0);
        const out=`/${name}-${index}-${copy}-${declared.length}.crc`,timed=await ffmpeg.exec([...declared,'-i',`/${name}.sol`,...tail,out]);expect(timed.exitCode,`${name}/${index}/${copy} ${JSON.stringify(timed.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${index}/${copy}/${declared.length}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(288);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('mirrors native SOL bad-tag and zero-rate statuses and refuses DPCM, partial samples, truncation and input seeks before any output',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-sol-refuse-');
  try{
    // AVERROR(e) exits with (-e)&255: the zero rate fails with EINVAL (host errno for native, the Linux 234 for EdgeFFmpeg); the bad tag is a literal -1 (255).
    const hostEinval=(256-constants.errno.EINVAL)&255,linuxEinval=234;
    const tag=sol(0x0c0d,8000,0,64);tag[5]=1;
    const mirrored=[['rate0-s16',sol(0x0c0d,0,4,64),[],hostEinval,linuxEinval],['rate0-u8',sol(0x0b8d,0,0,64),['-f','sol'],hostEinval,linuxEinval],['tag',tag,['-f','sol'],255,255]] as const;
    for(const [label,bytes,declared,status,edge] of mirrored){
      writeFileSync(join(root,`${label}.sol`),bytes);
      for(const tail of [['-f','s16le'],['-c:a','copy','-f','framecrc']]){
        const expected=run([...declared,'-i',join(root,`${label}.sol`),...tail,'-']);expect(expected.status,label).toBe(status);
        const result=await ffmpeg.exec([...declared,'-i',`/${label}.sol`,...tail,`/${label}.out`]);expect(result.exitCode,label).toBe(edge);expect(existsSync(join(root,`${label}.out`))).toBe(false);
      }
    }
    // Native accepts these (DPCM decodes, a 1-byte final packet, a zero-filled short header, a seek before the first packet); the port refuses them explicitly.
    const unported=[['dpcm-old',sol(0x0b8d,8000,1,500),[],/SOL DPCM/],['dpcm-new8',sol(0x0c0d,8000,1,500),[],/SOL DPCM/],['dpcm-new16',sol(0x0c8d,8000,5,500),[],/SOL DPCM/],['partial',sol(0x0c8d,8000,20,4097),[],/partial trailing/],
      ['short',sol(0x0c0d,8000,0,0).subarray(0,10),['-f','sol'],/Truncated SOL header/],['seek',sol(0x0c8d,8000,20,8192),['-ss','0.01'],/SOL input seeking/]] as const;
    for(const [label,bytes,before,message] of unported){
      writeFileSync(join(root,`${label}.sol`),bytes);
      expect(run([...before,'-i',join(root,`${label}.sol`),'-c:a','copy','-f','framecrc','-']).status,label).toBe(0);
      const result=await ffmpeg.exec([...before,'-i',`/${label}.sol`,'-f','s16le',`/${label}.raw`]);expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toMatch(message);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
