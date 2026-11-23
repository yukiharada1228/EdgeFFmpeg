import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('runs the rawvideo CLI launcher with staged frame-limited output and explicit unsupported-filter diagnostics',()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-launcher-'));
  try{
    const input=Uint8Array.from({length:81},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.yuv'),input);const before=['--root',root,'--','-f','rawvideo','-pixel_format','nv12','-video_size','5x3','-framerate','ntsc','-i','/input.yuv'];
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),...before,'-frames:v','2','-c:v','rawvideo','-f','rawvideo','/output.yuv'],{encoding:'utf8'}));expect(result).toEqual({exitCode:0,outputs:['/output.yuv'],diagnostics:[]});expect(readFileSync(join(root,'output.yuv'))).toEqual(Buffer.from(input.slice(0,54)));
    const failed=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),...before,'-vf','scale=iw/2:ih/2','-f','rawvideo','/failed.yuv'],{encoding:'utf8'});expect(failed.status).toBe(1);expect(JSON.parse(failed.stderr).diagnostics[0].code).toBe('unsupported-command');expect(existsSync(join(root,'failed.yuv'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs scoped rawvideo time selection through the actual CLI launcher with native framecrc output',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-time-launcher-'));
 try{
  writeFileSync(join(root,'input.yuv'),Uint8Array.from({length:81},(_,i)=>(i*37+13)&255));
  for(const codec of ['copy','rawvideo']){
   const before=['-ss','0.02','-f','rawvideo','-pixel_format','nv12','-video_size','5x3','-framerate','ntsc'],after=['-ss','0.02','-t','0.04','-c:v',codec,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.yuv'),...after,'-']);
   const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.yuv',...after,`/${codec}.crc`],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,`${codec}.crc`))).toEqual(expected);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs pixel packing conversion through the actual CLI launcher with native raw and framecrc output',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pixel-launcher-'));
 try{
  for(const [source,destination,size]of [['rgba','gbrp',60],['gbrp','abgr',45],['nv21','yuva420p',27],['yuva420p','nv12',42]] as const){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:size*2},(_,i)=>(i*37+13)&255));
   for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${source}-${format}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs default BT601 and gray color conversion through the actual CLI launcher with native outputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-color-launcher-'));
 try{
  for(const [source,destination,size]of [['rgba','yuv444p',60],['yuv444p','abgr',45],['gbrp','gray',45],['gray','nv21',15],['nv12','gray',27]] as const){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:size*2},(_,i)=>(i*37+13)&255));
   for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size','5x3','-framerate','25'],after=['-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${source}-${destination}-${format}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs chroma resampling and subsampled RGB conversion through the actual CLI launcher with native output',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-chroma-launcher-'));
 try{
  for(const [source,destination,width,size]of [['yuv444p','nv21',5,45],['yuv420p','yuv444p',5,27],['rgb24','yuv420p',5,45],['bgr24','yuva420p',6,54],['rgba','yuva420p',5,60]] as const){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:size*2},(_,i)=>(i*37+13)&255));
   for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x3`,'-framerate','25'],after=['-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${source}-${destination}-${format}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8'}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('runs subsampled YUV to RGB numeric profiles through the actual CLI and rejects unstable reference geometry',()=>{
 const pixelArithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edgeffmpeg-inverse-launcher-'));
 try{
  for(const [source,destination,width,height,scalar,size]of [['yuv420p','rgb24',16,2,false,48],['yuv420p','rgba',6,3,false,30],['yuva420p','bgra',5,7,false,94],['yuv422p','gbrp',5,3,false,33],['nv21','argb',16,6,true,144],['nv12','rgb24',5,3,false,27]] as const){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:size*2},(_,i)=>(i*37+13)&255));
   for(const format of ['rawvideo','framecrc']){
    const before=[...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-ss','0.02','-t','0.05','-pix_fmt',destination,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),output=`/${source}-${destination}-${format}.out`;
    const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,output],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:pixelArithmetic}}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
   }
  }
  const rejected=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--','-f','rawvideo','-pixel_format','nv12','-s','16x6','-i','/input.raw','-pix_fmt','rgb24','-f','rawvideo','/unstable.raw'],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:'aarch64'}});expect(rejected.status).toBe(1);expect(JSON.parse(rejected.stderr).diagnostics[0].message).toContain('nondeterministic');expect(existsSync(join(root,'unstable.raw'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
