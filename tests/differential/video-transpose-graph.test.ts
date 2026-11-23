import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native transpose graphs across declared formats and arithmetic profiles',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-flip-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const [width,height]of [[5,3]] as const){
   let seed=223;const input=Uint8Array.from({length:pixelLayout(source,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height},{maxFrameBytes:65536});
   for(const target of [null,...formats])for(const description of ['transpose','transpose=clock','transpose=cclock','transpose=clock_flip','transpose=4','transpose=7','transpose=clock:passthrough=landscape','transpose=2:passthrough=portrait','transpose=clock,format=rgba|gray','format=nv12|gray,transpose=clock','transpose=clock,scale=13:7','[x]transpose=cclock[out];[in]format=rgba|gray[x]'])for(const size of [null,'3x2'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    expect(Buffer.concat(actual.planes),`${source}/${width}x${height}/${target}/${description}/${size}/${arithmetic}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(10080);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);

