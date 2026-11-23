import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const families=[['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],['yuv420p','yuva420p','nv12','nv21'],['gray'],['yuv422p'],['yuv444p']];
it('matches native component-preserving pixel conversion bytes and framecrc across odd geometry SIMD boundaries and scoped timing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pixel-convert-'));
 try{
  const base=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),filesystem={async openRead(path:string){const input=await base.openRead(path);return {size:input.size,readAt:(offset:bigint,length:number,signal?:AbortSignal)=>input.readAt(offset,Math.min(length,7),signal)};},openWrite:base.openWrite},frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
  for(const family of families)for(const source of family)for(const destination of family)for(const [width,height]of [[1,1],[5,3],[8,6],[15,2],[16,2],[17,3],[33,3]] as const){
   const layout=pixelLayout(source,width,height);writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*4},(_,i)=>[0,1,127,128,254,255,(i*37+13)&255][i%7]!));
   for(const selection of [[],['-ss','0.02','-t','0.05'],['-frames:v','2']])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','30000/1001'],after=['-pix_fmt',destination,...selection,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),actual=readFileSync(join(root,out.slice(1))),label=`${source}/${destination}/${width}x${height}/${selection}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(actual.equals(expected),`${label}: expected ${expected.length} bytes, actual ${actual.length}; first mismatch ${actual.findIndex((value,i)=>value!==expected[i])}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native converted empty-stream descriptors alpha defaults and pixel aliases without producing payloads',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pixel-empty-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
  writeFileSync(join(root,'input.raw'),new Uint8Array());
  for(const family of families)for(const source of family)for(const destination of family)for(const scope of [[],['-ss','0','-t','0']]){
   const before=['-f','rawvideo','-pix_fmt',source==='gray'?'gray8':source,'-s','5x3'],after=['-pix_fmt',destination==='gray'?'gray8':destination,...scope,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${source}/${destination}/${scope}`).toBe(true);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
