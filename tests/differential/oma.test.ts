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
// libavformat/omadec.c layout: "EA3", a version byte, 0, 96, eid RB16, codec id at 32, codec params RB24 at 33, then the payload from byte 96 to EOF.
function oma(payload:number,{codecId=4,eid=0xffff,seed=1}:{codecId?:number;eid?:number;seed?:number}={}):Uint8Array{
  const bytes=new Uint8Array(96+payload),view=new DataView(bytes.buffer);
  bytes.set([0x45,0x41,0x33,0x01,0,96]);view.setUint16(6,eid,false);bytes[32]=codecId;bytes.set([0x02,0x20,0x56],33);bytes.fill(0xa5,36,96);
  let x=seed*2654435761>>>0;for(let i=0;i<payload;i++){x=(x*1103515245+12345)>>>0;bytes[96+i]=i%193<96?x>>>24:(i*29)&255;}
  return bytes;
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}})};}
const run=(args:string[])=>spawnSync(native,['-v','error',...args],{maxBuffer:1<<26});
/** Whole 1024-byte packets (0, 1, 2, 7 and 40), then short final packets of 4, 1020 and 3076 bytes past whole ones. */
const whole=[0,1024,2048,7*1024,40*1024],short=[4,1024+1020,3*1024+3076];
it('matches native OMA LPCM copy and decode framecrc, wav, raw s16be and aiff outputs for whole-packet payloads and refuses copy of a short final packet',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-oma-');let compared=0,refused=0;
  try{
    for(const payload of [...whole,...short])for(const declared of [[],['-f','oma']]){
      const name=`p${payload}-${declared.length}`,path=join(root,`${name}.oma`),tail=payload%1024!==0;writeFileSync(path,oma(payload,{seed:payload+1}));
      const cases:Array<[string,string[],boolean]>=[
        ['copy',['-c:a','copy','-bitexact','-f','framecrc'],true],['decode',['-c:a','pcm_s16le','-bitexact','-f','framecrc'],false],['decode-be',['-c:a','pcm_s16be','-bitexact','-f','framecrc'],false],
        ['wav',['-bitexact','-f','wav'],false],['raw-copy',['-c:a','copy','-f','s16be'],true],['raw',['-c:a','pcm_s16be','-f','s16be'],false],['aiff',['-bitexact','-f','aiff'],false]];
      for(const [kind,args,copy] of cases){
        const nativeOut=join(root,`${name}-${kind}.native`),expected=run([...declared,'-i',path,...args,nativeOut]);expect(expected.status,`${name}/${kind}`).toBe(0);
        if(kind==='copy'){
          // Claim detection only where native's framecrc header shows the OMA LPCM stream; whole packets carry no flag column, a short tail ends in F=0x3.
          const text=readFileSync(nativeOut,'utf8');
          if(!text.includes('#codec_id 0: pcm_s16be\n')||!text.includes('#sample_rate 0: 44100\n')||!text.includes('#channel_layout_name 0: stereo\n'))throw new Error(`native did not demux ${name} as OMA: ${text.slice(0,300)}`);
          const rows=text.split('\n').filter(line=>/^0,/.test(line));expect(rows.length,name).toBe(Math.ceil(payload/1024));
          expect(rows.slice(0,Math.floor(payload/1024)).every(row=>row.split(',').length===6&&/^0, +\d+, +\d+, +256,/.test(row)),name).toBe(true);
          if(tail)expect(rows.at(-1),name).toMatch(/, F=0x3$/);
        }
        const out=`/${name}-${kind}.out`,result=await ffmpeg.exec([...declared,'-i',`/${name}.oma`,...args,out]);
        if(copy&&tail){
          expect([result.exitCode,result.diagnostics.at(-1)?.code,result.diagnostics.at(-1)?.message],`${name}/${kind}`).toEqual([1,'unsupported-command','OMA stream copy of a short final packet (AV_PKT_FLAG_CORRUPT) is not implemented']);expect(existsSync(join(root,out.slice(1)))).toBe(false);refused++;continue;
        }
        expect(result.exitCode,`${name}/${kind} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(nativeOut)),`${name}/${kind}`).toBe(true);compared++;
      }
    }
    expect([compared,refused]).toEqual([100,12]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native OMA output -ss, -t and -frames selections for copy and decode',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-oma-time-');let compared=0;
  try{
    for(const payload of [60*1024,60*1024+516]){
      const name=`t${payload}`,path=join(root,`${name}.oma`);writeFileSync(path,oma(payload,{seed:payload}));
      const profiles=[['-ss','0.05'],['-t','0.1'],['-ss','0.013','-t','0.041'],['-ss','0.3','-t','0.2'],['-frames:a','3'],['-ss','10']];
      for(const [index,profile] of profiles.entries())for(const copy of payload%1024?[false]:[true,false])for(const declared of [[],['-f','oma']]){
        const tail=[...profile,...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=run([...declared,'-i',path,...tail,'-']);expect(expected.status).toBe(0);
        const out=`/${name}-${index}-${copy}-${declared.length}.crc`,timed=await ffmpeg.exec([...declared,'-i',`/${name}.oma`,...tail,out]);expect(timed.exitCode,`${name}/${index}/${copy} ${JSON.stringify(timed.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${index}/${copy}/${declared.length}`).toBe(true);compared++;
      }
      // Raw decode with a time range as well.
      const expected=run(['-i',path,'-ss','0.02','-t','0.05','-c:a','pcm_s16be','-f','s16be','-']),out=`/${name}-range.raw`,result=await ffmpeg.exec(['-i',`/${name}.oma`,'-ss','0.02','-t','0.05','-c:a','pcm_s16be','-f','s16be',out]);
      expect([expected.status,result.exitCode]).toEqual([0,0]);expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout)).toBe(true);compared++;
    }
    expect(compared).toBe(38);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('mirrors native OMA statuses for truncated, non-EA3, encrypted and unknown-codec headers and refuses ATRAC3, ea3 tags and input seeks before any output',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-oma-refuse-');
  try{
    // AVERROR(e) exits with (-e)&255: ENOSYS is the host errno for native (38 on Linux, 78 on macOS) and the Linux 218 for EdgeFFmpeg.
    // A short header and decrypt_init without a GEOB tag return a literal -1 (255); a bad EA3 header is AVERROR_INVALIDDATA (183).
    const hostEnosys=(256-constants.errno.ENOSYS)&255,linuxEnosys=218,bad=oma(64);bad[5]=95;
    const mirrored=[['truncated',oma(0).subarray(0,90),[],255,255],['bad-ea3',bad,['-f','oma'],183,183],['encrypted',oma(64,{eid:0x0001}),[],255,255],['encrypted-ff7f',oma(64,{eid:0xff7f}),['-f','oma'],255,255],
      ['codec5',oma(64,{codecId:5}),[],hostEnosys,linuxEnosys],['codec99',oma(64,{codecId:99}),['-f','oma'],hostEnosys,linuxEnosys]] as const;
    for(const [label,bytes,declared,status,edge] of mirrored){
      writeFileSync(join(root,`${label}.oma`),bytes);
      for(const tail of [['-f','s16be'],['-c:a','copy','-f','framecrc']]){
        const expected=run([...declared,'-i',join(root,`${label}.oma`),...tail,'-']);expect(expected.status,label).toBe(status);
        const result=await ffmpeg.exec([...declared,'-i',`/${label}.oma`,...tail,`/${label}.out`]);expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(edge);expect(existsSync(join(root,`${label}.out`))).toBe(false);
      }
    }
    // Native demuxes these (ATRAC3 copies, an ea3 tag is skipped with its metadata exported, an input seek lands on a packet); the port refuses them explicitly.
    const data=oma(4096),tag=Uint8Array.from([0x65,0x61,0x33,3,0,0,0,0,0,0,...data]);
    writeFileSync(join(root,'atrac.oma'),oma(4096,{codecId:0}));
    const atrac3=run(['-i',join(root,'atrac.oma'),'-c:a','copy','-f','framecrc','-']);expect(atrac3.status).toBe(0);expect(atrac3.stdout.toString()).toContain('#codec_id 0: atrac3\n');
    const unported=[['atrac',oma(4096,{codecId:0}),[],/OMA codec id 0 ATRAC3/],['tagged',tag,['-f','oma'],/OMA ID3v2 ea3 tag/],['seek',data,['-ss','0.01'],/OMA input seeking/]] as const;
    for(const [label,bytes,before,message] of unported){
      writeFileSync(join(root,`${label}.oma`),bytes);
      const expected=run([...before,'-i',join(root,`${label}.oma`),'-c:a','copy','-f','framecrc','-']);expect(expected.status,label).toBe(0);
      if(label==='tagged')expect(expected.stdout.toString()).toContain('#codec_id 0: pcm_s16be\n');
      const result=await ffmpeg.exec([...before,'-i',`/${label}.oma`,'-f','s16be',`/${label}.raw`]);expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toMatch(message);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
