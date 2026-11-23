import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
it('runs gray resizing and ignored copy sizes through the actual staged Node CLI with native whole outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resize-launcher-'));let index=0;
 try{
  for(const [sw,sh,size]of [[5,3,'13x7'],[17,9,'1x1'],[8,6,'32x18'],[2,2,'8x1'],[5,3,'copy']] as const){
   let seed=73;const data=Uint8Array.from({length:sw*sh*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.gray'),data);
   for(const format of ['rawvideo','framecrc']){
    const before=['-ss','0.02','-f','rawvideo','-pixel_format','gray','-video_size',`${sw}x${sh}`,'-framerate','25'],after=[...(size==='copy'?['-c:v','copy','-s','bad']:['-s:v:0',size]),'-ss','0.01','-t','0.07','-frames:v','2','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.gray'),...after,'-']),output=`/${index++}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.gray',...after,output],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('runs planar semiplanar and alpha resizing through the actual Node launcher with native whole outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-yuv-resize-launcher-'));let index=0;
 try{
  for(const pixelFormat of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'])for(const [sw,sh,size]of [[5,3,'13x7'],[17,9,'1x1'],[8,6,'32x18'],[2,2,'8x1'],[5,3,'copy']] as const){
   let seed=73;const data=Uint8Array.from({length:pixelLayout(pixelFormat,sw,sh).bytes*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
   for(const format of ['rawvideo','framecrc']){
    const before=['-ss','0.02','-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${sw}x${sh}`,'-framerate','25'],after=[...(size==='copy'?['-c:v','copy','-s','bad']:['-s:v:0',size]),'-pix_fmt',pixelFormat,'-ss','0.01','-t','0.07','-frames:v','2','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${index++}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8'}));expect(result.exitCode,pixelFormat).toBe(0);expect(readFileSync(join(root,output.slice(1))),`${pixelFormat}/${size}/${format}`).toEqual(expected);
   }
  }
  expect(index).toBe(60);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('runs packed and planar RGB resizing through the actual Node launcher with native whole outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-yuv-resize-launcher-'));let index=0;
 try{
  for(const pixelFormat of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [sw,sh,size]of [[5,3,'13x7'],[17,9,'1x1'],[8,6,'32x18'],[2,2,'8x1'],[5,3,'copy']] as const){
   let seed=73;const data=Uint8Array.from({length:pixelLayout(pixelFormat,sw,sh).bytes*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
   for(const format of ['rawvideo','framecrc']){
    const before=['-ss','0.02','-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${sw}x${sh}`,'-framerate','25'],after=[...(size==='copy'?['-c:v','copy','-s','bad']:['-s:v:0',size]),'-pix_fmt',pixelFormat,'-ss','0.01','-t','0.07','-frames:v','2','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${index++}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8'}));expect(result.exitCode,pixelFormat).toBe(0);expect(readFileSync(join(root,output.slice(1))),`${pixelFormat}/${size}/${format}`).toEqual(expected);
   }
  }
  expect(index).toBe(70);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('parses named input dimensions and numeric output separators through the actual staged Node launcher',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-size-launcher-'));
 try{
  writeFileSync(join(root,'input.gray'),Uint8Array.from({length:176*144},(_,i)=>(i*37+13)&255));
  for(const format of ['rawvideo','framecrc']){
   const before=['-f','rawvideo','-pixel_format','gray','-s','qcif'],after=['-s','2:3','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.gray'),...after,'-']);
   const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.gray',...after,`/output.${format}`],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,`output.${format}`))).toEqual(expected);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs sequential video filters and appended output sizing through the staged Node launcher',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-video-filter-launcher-'));let index=0;
 try{
  for(const pixelFormat of ['gray','yuv420p','yuva420p','nv21']){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:pixelLayout(pixelFormat,5,3).bytes*3},(_,i)=>(i*37+13)&255));
   for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',pixelFormat,'-video_size','5x3'],after=['-vf','null,scale=13:7,scale=5:3','-s','3x2','-ss','0.02','-t','0.05','-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`output.${index++}`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,`/${output}`],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output))).toEqual(expected);
   }
  }
  expect(index).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs fused resize and format conversion through the staged Node CLI with native whole outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-combined-launcher-'));let index=0;
 try{
  for(const [source,destination]of [['yuv420p','yuv444p'],['nv21','yuva420p'],['rgb24','nv12'],['rgba','gbrp'],['gbrp','gray'],['gray','bgra'],['gray','yuva420p'],['bgr24','rgb24']]){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:pixelLayout(source!,5,3).bytes*3},(_,i)=>(i*37+13)&255));
   for(const size of ['13x7','1x1'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source!,'-s','5x3'],after=['-s',size,'-pix_fmt',destination!,'-ss','0.02','-t','0.05','-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`output.${index++}`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,`/${output}`],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output))).toEqual(native);
   }
  }
  expect(index).toBe(32);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('runs resized YUV inverse profiles through the staged Node launcher with native whole outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inverse-resize-launcher-')),arithmetic=referencePixelArithmetic();let index=0;
 try{
  for(const source of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'])for(const target of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*37+13)&255));
   for(const size of ['4x3','13x7','20x9'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],after=['-s',size,'-pix_fmt',target,'-ss','0.02','-t','0.05','-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`output.${index++}`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,`/${output}`],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:arithmetic}}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output))).toEqual(native);
   }
  }
  expect(index).toBe(252);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
