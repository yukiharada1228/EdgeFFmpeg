import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native landscape portrait and square passthrough including legacy direction precedence',()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-transpose-geometry-'));let count=0;
 try{for(const format of ['gray','nv21','rgba'])for(const [width,height]of [[5,3],[3,5],[4,4]] as const){
 const data=Uint8Array.from({length:pixelLayout(format,width,height).bytes},(_,i)=>(i*37+17)&255),file=join(root,'in.raw');writeFileSync(file,data);const frame=decodeRawVideo({streamIndex:0,data,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});
 for(let direction=0;direction<8;direction++)for(const mode of ['none','landscape','portrait','3']){
 const description=`transpose=dir=${direction}:passthrough=${mode}`,plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=execFileSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);expect(Buffer.concat(actual.planes),`${format}/${width}x${height}/${description}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
 }
 }expect(count).toBe(288);}finally{rmSync(root,{recursive:true,force:true});}
});
