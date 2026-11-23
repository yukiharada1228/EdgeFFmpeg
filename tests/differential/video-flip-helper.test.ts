import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {flipVideoFrame} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native horizontal and vertical reflection across every declared plane layout',()=>{
 referencePixelArithmetic();
 const root=mkdtempSync(join(tmpdir(),'edge-flip-layout-'));let count=0;
 try{
  for(const format of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [width,height]of [[1,1],[1,5],[5,1],[2,2],[5,3],[6,4],[17,9],[32,6]] as const){
   let seed=197;const input=Uint8Array.from({length:pixelLayout(format,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});
   for(const description of ['hflip','vflip','hflip,vflip','vflip,hflip,hflip,vflip']){
    let actual=frame;for(const token of description.split(','))actual=flipVideoFrame(actual,token==='hflip'?'horizontal':'vertical',{maxFrameBytes:65536});
    const native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);
    expect(Buffer.concat(actual.planes),`${format}/${width}x${height}/${description}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(448);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
