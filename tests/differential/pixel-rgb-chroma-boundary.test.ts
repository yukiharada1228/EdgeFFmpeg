import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native paired RGB chroma at odd destination width boundaries',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgb-chroma-boundary-')),arithmetic=referencePixelArithmetic();let checked=0;
 try{for(const source of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const width of [4,6,8,10,12,14]){
  const input=Uint8Array.from({length:pixelLayout(source,width,3).bytes},(_,i)=>(i*37+59)&255),file=join(root,'input.raw');writeFileSync(file,input);const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height:3},{maxFrameBytes:65536});
  for(const destination of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'])for(const outputWidth of [width-1,width,width+1,width+2])for(const scalar of [false,true]){
   const profile=scalar?'scalar':arithmetic,state=pixelResizeStateBytes(source,width,3,outputWidth,7,destination,profile),actual=resizeVideoFrame(frame,outputWidth,7,{outputPixelFormat:destination,arithmetic:profile,maxFrameBytes:65536,maxStateBytes:state}),native=execFileSync('.build/reference/ffmpeg',['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x3`,'-i',file,'-s',`${outputWidth}x7`,'-pix_fmt',destination,'-bitexact','-f','rawvideo','-']);
   expect(Buffer.concat(actual.planes),`${source}/${width}/${destination}/${outputWidth}/${profile}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);checked++;
  }
 }expect(checked).toBe(2016);}finally{rmSync(root,{recursive:true,force:true});}
},120000);
