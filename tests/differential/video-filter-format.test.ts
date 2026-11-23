import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'];
it('matches native negotiated filter outputs and identity scale anchors across all format pairs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-format-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const destination of formats)for(const [width,height]of [[5,3],[6,4],[17,9]]){
   let seed=197;const input=Uint8Array.from({length:pixelLayout(source,width!,height!).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:width!,height:height!},{maxFrameBytes:65536});
   for(const description of ['null','scale','scale=13:7','null,scale=13:7,null','scale=13:7,scale=5:3','scale=13:7,null,scale=5:3,null','scale=13:7,scale','scale=13:7,null,scale,null'])for(const size of [null,'3x2','13x7']){
    const plan=compileVideoFilterChain(description).plan(source,width!,height!,{outputPixelFormat:destination,...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),output=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes,arithmetic}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),'-pix_fmt',destination,'-f','rawvideo','-']);
    expect(Buffer.concat(output.planes),`${source}/${destination}/${width}x${height}/${description}/${size}`).toEqual(native);expect(output.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(14112);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native single format constraints before between and after scale stages',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-constraint-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const destination of formats){
   let seed=53;const input=Uint8Array.from({length:pixelLayout(source,5,3).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);const frame=decodeRawVideo({streamIndex:0,data:input,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:65536});
   for(const middle of ['nv12','gray','gbrp'])for(const description of [`format=${middle}`,`format=${middle},scale=13:7`,`scale=13:7,format=${middle}`,`scale=13:7,format=${middle},scale=5:3`,`format=${middle},scale=13:7,scale=5:3`,`scale=13:7,null,format=${middle},null,scale=5:3`])for(const size of [null,'3x2']){
    const plan=compileVideoFilterChain(description).plan(source,5,3,{outputPixelFormat:destination,...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),output=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes,arithmetic}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),'-pix_fmt',destination,'-f','rawvideo','-']);
    expect(Buffer.concat(output.planes),`${source}/${destination}/${description}/${size}`).toEqual(native);count++;
   }
  }
  expect(count).toBe(7056);
 }finally{rmSync(root,{recursive:true,force:true});}
},90000);
