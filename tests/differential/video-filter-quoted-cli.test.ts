import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
it('matches native quoted filter CLI outputs across timing size and format scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-format-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const [source,target]of [['rgba','nv12'],['nv21','bgra'],['yuv444p','gbrp'],['gray','yuva420p'],['gbrp','gray'],['bgr24','rgba'],['yuva420p','rgb24'],['rgb24','yuv422p']]){
   const input=Uint8Array.from({length:pixelLayout(source!,5,3).bytes*4},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),input);
   for(const description of ["'null'", "format='rgba|gray',hflip", "format=\\'rgba|gray\\',scale='13:7',vflip", "scale=w='13':h='7':flags='bicubic',vflip", "format=rgba:pix_fmts=gray,scale=h=7,hflip", "scale='13,7',format='0x1a|8',hflip,"])for(const size of [null,'3x2','13x7'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.02'],['-t','0.05']],[[],['-ss','0.02','-t','0.05']],[['-ss','0.03'],['-ss','0.01','-t','0.07','-frames:v','1']]]){
    const before=['-f','rawvideo','-pixel_format',source!,'-s','5x3',...inputTime!],after=['-vf',description,...(size?['-s',size]:[]),'-pix_fmt',target!,...outputTime!,'-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput(),frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return sink.output;}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
    const result=await frontend.exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,target,description,size,format,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${size}/${format}/${inputTime}/${outputTime}`).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(1152);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('matches native quoted filter implicit outputs for empty and time-clipped streams',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-default-format-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const description of ["'null'", "format=\\'rgba|gray\\',vflip", "scale='13,7',hflip,", "scale=flags=bogus:flags=bicubic,format=8;"])for(const size of [null,'3x2'])for(const format of ['rawvideo','framecrc'])for(const [empty,time]of [[true,[]],[false,['-frames:v','0']],[false,['-t','0']],[false,['-ss','0.02','-t','0.05']]] as const){
   const input=Uint8Array.from({length:empty?0:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),input);
   const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],after=['-vf',description,...(size?['-s',size]:[]),...time,'-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput(),frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return sink.output;}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
   const result=await frontend.exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,description,size,format,empty,time,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${description}/${size}/${format}/${empty}/${time}`).toEqual(native);count++;
  }
  expect(count).toBe(896);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
