import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000};
/** Deterministic 7-bit (or 8-bit) payload bytes; the SDS layout is written here, independent of the module. */
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};}
function dump(depth:number,period:number,packets:number,seed:number,mask=0x7f):Uint8Array{
  const next=random(seed),bytes=new Uint8Array(21+127*packets);bytes.set([0xf0,0x7e,0x00,0x01,0x00,0x00,depth,period&0x7f,(period>>7)&0x7f,(period>>14)&0x7f,0x7f,0x7f,0x01]);bytes[20]=0xf7;
  for(let p=0;p<packets;p++){const base=21+127*p;bytes.set([0xf0,0x7e,0x00,0x02,p&0x7f],base);for(let i=0;i<120;i++)bytes[base+5+i]=Math.floor(next()*256)&mask;bytes[base+125]=0x2a;bytes[base+126]=0xf7;}
  return bytes;
}
function nativeFile(args:readonly string[],path:string):Buffer{execFileSync(native,['-v','error','-y',...args,path],{timeout:30000});return readFileSync(path);}
function checkReference(){
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+sds\s/);
}
const depths=[8,13,14,20,21,28],periods=[0,22675,1,0x1fffff],counts=[0,1,7];
it('matches native SDS copy framecrc, s16le decode and WAV for six bit depths four periods and zero one or seven packets',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sds-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0,files=0;
    const cases:Array<[number,number,number,number]>=[];for(const depth of depths)for(const period of periods)for(const count of counts)cases.push([depth,period,count,0x7f]);
    // 8-bit payload bytes: byte2_read adds where byte3/4_read OR, and native accepts them.
    for(const depth of [8,20,28])cases.push([depth,22675,7,0xff]);
    for(const [depth,period,count,mask] of cases){
      const name=`d${depth}-p${period}-n${count}-m${mask}`;writeFileSync(join(root,`${name}.sds`),dump(depth,period,count,depth*7919+period+count*31+mask));files++;
      for(const [suffix,before,after] of [['copy.crc',[],['-c:a','copy','-bitexact','-f','framecrc']],['decode.raw',['-cpuflags','0'],['-f','s16le']],['decode.wav',['-cpuflags','0'],['-bitexact','-f','wav']],['copy.raw',[],['-c:a','copy','-f','u32le']]] as const){
        const expected=nativeFile([...before,'-i',join(root,`${name}.sds`),...after],join(root,`${name}.native.${suffix}`)),out=`/${name}.${suffix}`,run=await ffmpeg.exec([...before,'-i',`/${name}.sds`,...after,out]);
        expect(run.exitCode,`${name}/${suffix} ${JSON.stringify(run.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${name}/${suffix}`).toBe(true);compared++;
      }
    }
    expect([files,compared]).toEqual([75,300]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native SDS packet timing for -t, -frames:a, declared -f sds and filtered decode',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sds-timing-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0;
    for(const depth of [8,16,24])for(const period of [0,22675]){
      const name=`t${depth}-${period}`;writeFileSync(join(root,`${name}.sds`),dump(depth,period,7,depth+period));
      const profiles=[{before:[],after:['-t','0.004']},{before:[],after:['-frames:a','2']},{before:[],after:['-t','0.0001']},{before:['-f','sds'],after:['-frames:a','0']},{before:['-f','sds'],after:['-t','1']}];
      for(const [index,profile] of profiles.entries())for(const copy of [true,false])for(const [format,extra] of [['framecrc',['-bitexact']],['wav',['-bitexact']]] as const){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1','-c:a','pcm_s16le']),...extra,'-f',format];
        if(copy&&format==='wav')continue;
        const out=`/${name}-${index}-${copy}.${format}`,expected=nativeFile([...before,'-i',join(root,`${name}.sds`),...after],join(root,'native'+out.slice(1))),result=await ffmpeg.exec([...before,'-i',`/${name}.sds`,...after,out]);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),out).toBe(true);compared++;
      }
    }
    expect(compared).toBe(90);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native when a declared -f sds ignores byte 2, which sds_read_header skips unchecked, and refuses it undetected',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sds-byte2-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0;
    for(const value of [0x05,0x7f,0xff])for(const depth of [8,16,24]){
      const bytes=dump(depth,22675,3,depth+value);bytes[2]=value;const name=`b${value}-${depth}`;writeFileSync(join(root,`${name}.sds`),bytes);
      for(const [after,format] of [[['-c:a','copy','-bitexact'],'framecrc'],[['-c:a','pcm_s16le','-bitexact'],'wav']] as const){
        const out=`/${name}.${format}`,expected=nativeFile(['-f','sds','-i',join(root,`${name}.sds`),...after,'-f',format],join(root,'native'+out.slice(1))),result=await ffmpeg.exec(['-f','sds','-i',`/${name}.sds`,...after,'-f',format,out]);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),out).toBe(true);compared++;
      }
    }
    expect(compared).toBe(18);
    // Undeclared: without the .sds extension native's probe rejects byte 2 (183). With it, native falls back to the
    // extension at score 1 when no other probe claims the file (0); detection here is by content only, so both are refused.
    const zero=dump(16,0,3,1,0);zero[2]=0x05;
    for(const [name,status] of [['byte2.bin',183],['byte2.sds',0]] as const){
      writeFileSync(join(root,name),zero);
      expect(spawnSync(native,['-v','error','-y','-i',join(root,name),'-c:a','copy','-f','framecrc',join(root,`${name}.native.crc`)],{timeout:15000}).status,name).toBe(status);
      const result=await ffmpeg.exec(['-i',`/${name}`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message,name).toBe('Unsupported audio container signature');expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses malformed SDS before any output and records native exit statuses',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-sds-errors-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{...budget,maxBufferBytes:64}});
    const valid=dump(16,0,3,5),change=(index:number,value:number)=>{const bytes=valid.slice();bytes[index]=value;return bytes;};
    // Native statuses: mid-stream demux errors and a truncated last packet still exit 0 (native drops or stops),
    // undetected depths fall through to another probe (187), a declared bad depth fails read_header (183), and a declared 20-byte header opens as an empty stream (0).
    const cases:Array<[string,Uint8Array,readonly string[],number,RegExp]>=[
      ['bad-f07e',change(21+127,0x00),[],0,/^Invalid SDS data packet header at 148$/],
      ['bad-f07e-first',change(22,0x7d),['-f','sds'],0,/^Invalid SDS data packet header at 21$/],
      ['missing-f7',change(21+127*2-1,0x00),[],0,/^Missing SDS data packet end at 148$/],
      ['truncated',valid.subarray(0,valid.length-10),[],0,/^Truncated SDS data packet$/],
      ['trailing',Uint8Array.from([...valid,0xf0,0x7e]),[],0,/^Truncated SDS data packet$/],
      // sds_probe tests AV_RB32(buf) == 0xF07E0001, so a nonzero byte 2 is not SDS by content; with these payloads another probe takes the .sds file (187).
      ['byte2',change(2,0x05),[],187,/^Unsupported audio container signature$/],
      ['byte2-ff',change(2,0xff),[],187,/^Unsupported audio container signature$/],
      ['depth7',change(6,7),[],187,/^Unsupported audio container signature$/],
      ['depth29',change(6,29),[],187,/^Unsupported audio container signature$/],
      ['depth7-declared',change(6,7),['-f','sds'],183,/^Invalid SDS bit depth: 7$/],
      ['depth29-declared',change(6,29),['-f','sds'],183,/^Invalid SDS bit depth: 29$/],
      ['header-declared',valid.subarray(0,20),['-f','sds'],0,/^Truncated SDS header$/]
    ];
    const statuses:Record<string,number|null>={};
    for(const [name,bytes,declare,status,message] of cases){
      writeFileSync(join(root,`${name}.sds`),bytes);
      const nativeRun=spawnSync(native,['-v','error','-y',...declare,'-i',join(root,`${name}.sds`),'-c:a','copy','-f','framecrc',join(root,`${name}.native.crc`)],{timeout:15000});statuses[name]=nativeRun.status;
      expect(nativeRun.status,name).toBe(status);
      const result=await ffmpeg.exec([...declare,'-i',`/${name}.sds`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message,name).toMatch(message);expect(result.outputs).toEqual([]);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
    // Native input -ss on sds seeks through the generic index: shifted timestamps, then a demux error; refused here.
    writeFileSync(join(root,'seek.sds'),dump(16,22675,7,9));
    const seekCheck=spawnSync(native,['-v','error','-ss','0.001','-i',join(root,'seek.sds'),'-c:a','copy','-f','framecrc','-'],{timeout:15000,encoding:'utf8'});expect(seekCheck.status).toBe(0);expect(seekCheck.stdout).toMatch(/^0,\s+-4,\s+-4,\s+40,/m);expect(seekCheck.stderr).toMatch(/Error during demuxing/);
    const seek=await ffmpeg.exec(['-ss','0.001','-i','/seek.sds','-c:a','copy','-f','framecrc','/seek.crc']);expect(seek.exitCode).not.toBe(0);expect(seek.diagnostics.at(-1)?.message).toBe('SDS input seeking is not implemented');expect(existsSync(join(root,'seek.crc'))).toBe(false);
    // sds is demux-only in native and here.
    expect(spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'truncated.sds'),'-f','sds',join(root,'out.sds')],{timeout:15000}).status).not.toBe(0);
    const mux=await ffmpeg.exec(['-f','s16le','-i','/truncated.sds','-f','sds','/out.sds']);expect(mux.exitCode).not.toBe(0);expect(mux.diagnostics.at(-1)?.message).toMatch(/^Output requires /);expect(existsSync(join(root,'out.sds'))).toBe(false);
    expect(Object.keys(statuses)).toHaveLength(12);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
