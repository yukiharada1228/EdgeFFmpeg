import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
it('runs explicit Linux x86_64 numeric profiles through the launcher against locked default-native bytes',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/inverse-linux-x64.json','utf8')) as {cases:{id:string;source:string;destination:string;width:number;height:number;native:{default:string}}[]};
 const ids=['yuv420p-bgr24-16x7','yuva420p-bgra-16x7','yuv422p-bgra-16x7','nv12-rgba-32x8','nv21-bgra-16x6','nv12-rgb24-5x3'],root=mkdtempSync(join(tmpdir(),'edgeffmpeg-linux-profile-'));
 try{
  for(const id of ids){
   const item=fixture.cases.find(item=>item.id===id)!;let seed=53;
   const data=Uint8Array.from({length:pixelLayout(item.source,item.width,item.height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
   const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--','-f','rawvideo','-pixel_format',item.source,'-video_size',`${item.width}x${item.height}`,'-i','/input.raw','-frames:v','1','-pix_fmt',item.destination,'-f','rawvideo',`/${id}.raw`],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:'x86_64'}}));
   expect(result.exitCode,id).toBe(0);expect(createHash('sha256').update(readFileSync(join(root,`${id}.raw`))).digest('hex'),id).toBe(item.native.default);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('runs resized Linux MMXEXT and explicit scalar overrides through the staged Node launcher',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-inverse-linux.json','utf8')) as {cases:{id:string;format:string;destination:string;sw:number;sh:number;dw:number;dh:number;native:{default:string;scalar:string}}[]},root=mkdtempSync(join(tmpdir(),'edge-linux-resize-'));let count=0;
 try{
  for(const source of ['yuv420p','yuva420p'])for(const target of ['bgr24','bgra','rgba']){
   const c=fixture.cases.find(c=>c.format===source&&c.destination===target&&c.native.default!==c.native.scalar)!;expect(c).toBeDefined();let seed=73;const input=Uint8Array.from({length:pixelLayout(c.format,c.sw,c.sh).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   for(const profile of ['default','scalar'] as const){const output=`${count++}.raw`,result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...(profile==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',c.format,'-s',`${c.sw}x${c.sh}`,'-i','/input.raw','-s',`${c.dw}x${c.dh}`,'-pix_fmt',c.destination,'-f','rawvideo',`/${output}`],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:'x86_64'}}));expect(result.exitCode).toBe(0);expect(createHash('sha256').update(readFileSync(join(root,output))).digest('hex')).toBe(c.native[profile]);}
  }
  expect(count).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
});
