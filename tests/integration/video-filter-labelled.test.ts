import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('runs labelled single-path video graphs through the staged Node launcher',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-graph-labelled-launcher-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const [source,target]of [['rgba','nv12'],['nv21','bgra'],['yuv444p','gbrp'],['gray','yuva420p'],['gbrp','gray'],['bgr24','rgba'],['yuva420p','rgb24'],['rgb24','yuv422p']]){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:pixelLayout(source!,5,3).bytes*3},(_,i)=>(i*37+13)&255));
   for(const description of ["[in]hflip[out]", "[x]scale=13:7[out];[in]format=rgba|gray[x]", "[b]scale=13:7[out];[a]format=yuva420p|nv12[b];[in]format=rgba|nv12[a]", "[in]hflip[x];[x]vflip[x]"])for(const destination of [target,null])for(const size of ['4x3','13x7'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source!,'-s','5x3'],after=['-vf',description,'-s',size,...(destination?['-pix_fmt',destination]:[]),'-ss','0.02','-t','0.05','-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),file=`${count++}.out`,result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...before,'-i','/input.raw',...after,`/${file}`],{encoding:'utf8',env:{...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:arithmetic}}));expect(result.exitCode).toBe(0);expect(readFileSync(join(root,file))).toEqual(native);
   }
  }
  expect(count).toBe(256);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
