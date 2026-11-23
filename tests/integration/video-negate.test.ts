import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('runs linear video negation and format conversion through the staged Node launcher',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-graph-negate-launcher-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const [source,target]of [['rgba','nv12'],['nv21','bgra'],['yuva420p','rgb24'],['gbrp','gray']]){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:pixelLayout(source!,5,3).bytes*3},(_,i)=>(i*37+13)&255));
   for(const description of ['negate=','format=nv12,negate=negate_alpha=1,scale=13:7,hflip='])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source!,'-s','5x3'],after=['-vf',description,'-pix_fmt',target!,'-ss','0.02','-t','0.05','-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),file=`${count++}.out`,result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,`/${file}`],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:arithmetic}}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,file))).toEqual(native);
   }
  }
  expect(count).toBe(16);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
