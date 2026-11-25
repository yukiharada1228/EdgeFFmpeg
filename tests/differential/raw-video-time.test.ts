import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {nativeFrameCountOutcome,referenceNumericProfile} from '../helpers/reference-numeric-profile.js';
const native=resolve('.build/reference/ffmpeg');
it('matches scoped rawvideo seeks durations stops and frame limits with native copy and encoding timestamps',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-time-')),numericProfile=referenceNumericProfile();let rejected=0;
 try{
  const base=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),filesystem={async openRead(path:string){const input=await base.openRead(path);return {size:input.size,readAt:(offset:bigint,length:number,signal?:AbortSignal)=>input.readAt(offset,Math.min(length,3),signal)};},openWrite:base.openWrite},frontend=new FFmpeg({filesystem,backend:createMediaBackend({numericProfile}),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
  const cases:[string[],string[]][]=[
   ...['0','0.000001','0.019999','0.02','0.020001','0.04','0.06','10'].map(value=>[['-ss',value],[]] as [string[],string[]]),
   ...['0','0.000001','0.019999','0.02','0.040001','0.06'].map(value=>[['-t',value],[]] as [string[],string[]]),
   ...['0','0.000001','0.019999','0.02','0.020001','0.04','0.06','10'].map(value=>[[],['-ss',value]] as [string[],string[]]),
   ...['0','0.000001','0.019999','0.02','0.040001','0.06'].map(value=>[[],['-t',value]] as [string[],string[]]),
   [['-ss','0.02','-to','0.12'],[]],[['-ss','0.02','-t','0.1','-to','0.08'],[]],
   [[],['-ss','0.02','-to','0.12']],[[],['-ss','0.02','-t','0.1','-to','0.08']],
   [['-ss','0.02'],['-ss','0.02']],[[],['-ss','0.02','-t','0.000001']],[[],['-ss','0.020001','-t','0.000001']],
   [['-ss','10'],['-ss','0']],[['-ss','10'],['-t','0']],[['-ss','10','-t','0'],[]],
   [['-ss','0.020001','-t','0.1'],['-ss','0.019999','-to','0.12','-frames:v','2']],
   [['-ss','10'],['-frames:v','0']],[[],['-ss','0.02','-frames:v','-1']],[[],['-ss','0.02','-frames:v','9223372036854775807']]
  ];
  for(const pixel of ['gray','yuv420p','rgba'])for(const rate of ['25','30000/1001','23.976','7/3']){
   const layout=pixelLayout(pixel,5,3);writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*17},(_,i)=>(i*37+13)&255));
   for(const [inputTime,outputTime]of cases)for(const codec of ['copy','rawvideo'])for(const format of ['rawvideo','framecrc']){
    const before=[...inputTime,'-f','rawvideo','-pixel_format',pixel,'-video_size','5x3','-framerate',rate],after=['-c:v',codec,...outputTime,'-bitexact','-f',format],label=`${pixel}/${rate}/${inputTime}/${codec}/${outputTime}/${format}`,at=outputTime.indexOf('-frames:v');
    // The reference CPU decides whether native accepts a count whose double is 2^63; Edge follows the same profile.
    const outcome=at<0?{accepted:true} as const:nativeFrameCountOutcome(numericProfile,'frames:v',outputTime[at+1]!),reference=spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),expected=reference.stdout,out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);
    if(!outcome.accepted){rejected++;expect(reference.status,label).toBe(outcome.status);expect(String(reference.stderr),label).toContain(outcome.message);expect(expected.length,label).toBe(0);expect(result.exitCode,label).toBe(outcome.status);expect(result.diagnostics.at(-1),label).toEqual({code:'invalid-arguments',message:outcome.message});expect(existsSync(join(root,out.slice(1))),label).toBe(false);continue;}
    expect(reference.status,`${label}: ${String(reference.stderr)}`).toBe(0);expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${label}\nexpected: ${format==='framecrc'?expected.toString():expected.length}\nactual: ${format==='framecrc'?readFileSync(join(root,out.slice(1))).toString():readFileSync(join(root,out.slice(1))).length}`).toBe(true);
   }
  }
  expect(rejected).toBe(numericProfile==='linux-x64'?48:0);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches microsecond boundary timing at slow fractional and high rawvideo rates with extended time-base quantization',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-time-boundaries-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
  writeFileSync(join(root,'input.raw'),Uint8Array.from({length:9*6},(_,i)=>(i*37+13)&255));
  const decimal=(micros:bigint)=>`${micros/1000000n}.${String(micros%1000000n).padStart(6,'0')}`;
  for(const [num,den]of [[1n,100n],[1n,1n],[7n,3n],[30000n,1001n],[24000n,1001n],[60n,1n],[1000n,1n],[1001000n,1n]] as const)for(const delta of [-2n,-1n,0n,1n,2n]){
   const half=1000000n*den/(2n*num)+delta,value=decimal(half<0n?0n:half),period=decimal(1000000n*den/num);
   const cases:[string[],string[]][]=[[['-ss',value],[]],[[],['-ss',value]],[['-t',value],[]],[[],['-t',value]],[[],['-ss',value,'-t',period]],[[],['-ss',value,'-t','0.000001']],[['-ss',value],['-ss',value]]];
   for(const [inputTime,outputTime]of cases)for(const codec of ['copy','rawvideo'])for(const format of ['rawvideo','framecrc']){
    const before=[...inputTime,'-f','rawvideo','-pixel_format','gray','-video_size','3x2','-framerate',`${num}/${den}`],after=['-c:v',codec,...outputTime,'-bitexact','-f',format],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${num}/${den}/${inputTime}/${codec}/${outputTime}/${format}`;expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${label}\nexpected: ${format==='framecrc'?expected.toString():expected.length}\nactual: ${format==='framecrc'?readFileSync(join(root,out.slice(1))).toString():readFileSync(join(root,out.slice(1))).length}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
