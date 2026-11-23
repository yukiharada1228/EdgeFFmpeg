import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const formats=['yuv420p','yuva420p','nv12','nv21','yuv422p','yuv444p'];
it('matches native default bicubic YUV chroma resampling bytes and framecrc across odd borders tiny planes and scoped timing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-chroma-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:262144,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});let index=0;
  for(const source of formats)for(const destination of formats)for(const [width,height]of [[1,1],[2,2],[3,3],[5,3],[8,6],[17,9],[33,31],[127,65]] as const){
   const layout=pixelLayout(source,width,height);let seed=37;writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}));
   for(const selection of [[],['-ss','0.02','-t','0.05']])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-pix_fmt',destination,...selection,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${source}/${destination}/${width}x${height}/${selection}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.equals(expected),`${label}: mismatch ${actual.findIndex((value,i)=>value!==expected[i])}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);

it('matches native packed and planar RGB to subsampled YUV including BGR fast paths alpha quantization and odd edges',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rgb-chroma-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});let index=0;
  for(const source of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const destination of ['yuv420p','yuva420p','nv12','nv21','yuv422p'])for(const [width,height]of [[1,1],[2,2],[3,3],[5,3],[8,6],[17,9],[33,31],[127,65]] as const){
   const layout=pixelLayout(source,width,height);let seed=73;writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}));
   for(const selection of [[],['-ss','0.02','-t','0.05']])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-pix_fmt',destination,...selection,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${source}/${destination}/${width}x${height}/${selection}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.equals(expected),`${label}: mismatch ${actual.findIndex((value,i)=>value!==expected[i])}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
