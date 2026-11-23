import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
it('matches native linear null and scale chains with scoped time selection and appended output sizes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-video-filter-'));let count=0;
 try{
  for(const pixelFormat of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [width,height]of [[5,3],[8,6],[17,9]]){
   let seed=197;const data=Uint8Array.from({length:pixelLayout(pixelFormat,width!,height!).bytes*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
   for(const filter of ['null','scale','scale=13:7','null,scale=w=13:h=7:flags=bicubic,null','scale=2:2,scale=5:7'])for(const outputSize of [[],['-s','3x2']])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${width}x${height}`,'-ss','0.02'],after=[['-vf','-filter','-filter:v','-filter:v:0','-filter:0'][count%5]!,filter,...outputSize,'-ss','0.01','-t','0.07','-frames:v','2','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const edge=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,7));}};},async openWrite(){return sink.output;}},backend:createMediaBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
    const result=await edge.exec([...before,'-i','/input.raw',...after,'/out']);expect(result.exitCode,JSON.stringify({pixelFormat,width,height,filter,outputSize,format,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${pixelFormat}/${width}x${height}/${filter}/${outputSize}/${format}`).toEqual(expected);count++;
   }
  }
  expect(count).toBe(840);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
