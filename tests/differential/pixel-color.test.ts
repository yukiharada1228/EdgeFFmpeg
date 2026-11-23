import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const rgb=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],yuv=['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'];
const pairs:[string,string][]=[...rgb.flatMap(pixel=>[[pixel,'yuv444p'],['yuv444p',pixel],[pixel,'gray'],['gray',pixel]] as [string,string][]),...yuv.flatMap(pixel=>[[pixel,'gray'],['gray',pixel]] as [string,string][])];
it('matches native default BT601 RGB YUV444 and gray conversion bytes including range clipping rounding and scoped timing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pixel-color-'));
 try{
  const base=await createNodeFileSystem({root,maxReadBytes:8192,maxWriteBytes:8192}),filesystem={async openRead(path:string){const source=await base.openRead(path);return {size:source.size,readAt:(offset:bigint,length:number,signal?:AbortSignal)=>source.readAt(offset,Math.min(length,11),signal)};},openWrite:base.openWrite},frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:131072,maxBufferBytes:8192,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
  for(const [source,destination]of pairs)for(const [width,height]of [[1,1],[5,3],[8,6],[15,2],[16,2],[17,3],[33,3]] as const){
   const layout=pixelLayout(source,width,height);writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*4},(_,i)=>[0,1,15,16,17,127,128,129,234,235,236,239,240,241,254,255,(i*37+13)&255][i%17]!));
   for(const selection of [[],['-ss','0.02','-t','0.05'],['-frames:v','2']])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','30000/1001'],after=['-pix_fmt',destination,...selection,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${source}/${destination}/${width}x${height}/${selection}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.equals(expected),`${label}: expected ${expected.length}, actual ${actual.length}, mismatch ${actual.findIndex((value,i)=>value!==expected[i])}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native fixed-point color output for deterministic random pixels full gray ramps and out-of-range YUV extremes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-color-random-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:1024*1024,maxWriteBytes:1024*1024}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:16*1024*1024,maxBufferBytes:1024*1024,maxPendingPackets:2,maxCpuTimeMs:10000}});let index=0;
  for(const [source,destination]of pairs)for(const seed of [0,37,65535]){
   const width=257,height=31,layout=pixelLayout(source,width,height);let state=seed;
   const data=Uint8Array.from({length:layout.bytes},(_,i)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return seed===0?i&255:state>>>24;});writeFileSync(join(root,'input.raw'),data);
   const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`],after=['-pix_fmt',destination,'-bitexact','-f','rawvideo'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${source}/${destination}/${seed}`;
   expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.equals(expected),`${label}: mismatch ${actual.findIndex((value,i)=>value!==expected[i])}`).toBe(true);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
