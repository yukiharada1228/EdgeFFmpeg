import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {negateVideoFrame,parseNegateOptions,VideoNegateError} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native negate components and alpha policy across every supported plane layout',()=>{
 referencePixelArithmetic();
 const root=mkdtempSync(join(tmpdir(),'edge-negate-layout-'));let accepted=0,rejected=0;
 try{
  for(const format of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [width,height]of [[1,1],[1,5],[5,1],[2,2],[5,3],[17,9]] as const){
   let seed=211;const input=Uint8Array.from({length:pixelLayout(format,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});
   for(const options of [null,'negate_alpha=1','y','u','v','a','r','g','b','r+a','g+b','y:1','components=y+u+v+a','none','y+u+v+r+g+b','-a','+a','-r','all','0x10']){
    const description=options===null?'negate':`negate=${options}`,native=spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
    expect(native.error,description).toBeUndefined();let actual:VideoFrameData|null=null;
    try{actual=negateVideoFrame(frame,parseNegateOptions(options),{maxFrameBytes:65536});}catch(error){expect(error,description).toBeInstanceOf(VideoNegateError);expect((error as Error).message).toBe('Requested components not available');}
    expect(actual!==null,`${format}/${width}x${height}/${description}`).toBe(native.status===0);
    if(actual){expect(Buffer.concat(actual.planes),`${format}/${width}x${height}/${description}`).toEqual(native.stdout);expect(actual.pts).toEqual(frame.pts);expect(actual.planes[0]).not.toBe(frame.planes[0]);accepted++;}
    else{expect(native.stderr.toString(),description).toContain('Requested components not available');rejected++;}
   }
  }
  expect([accepted,rejected]).toEqual([726,714]);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
