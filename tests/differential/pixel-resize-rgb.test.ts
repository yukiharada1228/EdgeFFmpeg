import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
it('matches native default and scalar RGB resize stages over arbitrary ratios',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-yuv-resize-'));let cases=0;
 try{
  for(const format of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [sw,sh]of [[1,1],[2,2],[3,3],[5,3],[6,4],[8,6],[17,9],[64,33],[128,65]] as const){
   const shapes=new Set([[sw,sh],[sw*2,sh*2],[Math.ceil(sw/2),Math.ceil(sh/2)],[sw,sh*2],[sw*2,sh],[1,1],[2,2],[3,1],[4,3],[5,7],[sw*4,sh*3],[sw*4,1]].map(([w,h])=>`${w}x${h}`));
   for(const seedValue of [0,73,197]){
    let seed=seedValue;const data=Uint8Array.from({length:pixelLayout(format,sw,sh).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
    const input=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:sw,height:sh},{maxFrameBytes:524288});
    for(const shape of shapes){
     const [dw,dh]=shape.split('x').map(Number) as [number,number],state=pixelResizeStateBytes(format,sw,sh,dw,dh),output=resizeVideoFrame(input,dw,dh,{maxFrameBytes:524288,maxStateBytes:state}),actual=Buffer.concat(output.planes);
     for(const cpu of [[],['-cpuflags','0']]){
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...cpu,'-f','rawvideo','-pixel_format',format,'-video_size',`${sw}x${sh}`,'-i',join(root,'input.raw'),'-s',shape,'-pix_fmt',format,'-f','rawvideo','-']);
      expect(actual.equals(expected),`${format}/${sw}x${sh}/${shape}/${seedValue}/${cpu}: first mismatch ${actual.findIndex((v,i)=>v!==expected[i])}`).toBe(true);cases++;
     }
    }
   }
  }
  expect(cases).toBe(4200);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native RGB resizing with scoped seeks frame limits and whole framecrc output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-yuv-resize-cli-'));let cases=0;
 try{
  for(const pixelFormat of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [sw,sh]of [[1,1],[3,2],[5,3],[8,6],[17,9],[64,33]] as const)for(const seedValue of [73,197]){
   let seed=seedValue;const data=Uint8Array.from({length:pixelLayout(pixelFormat,sw,sh).bytes*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
   const shapes=new Set(['1x1','2x2','5x7',`${sw*2}x${sh*2}`,`${sw*4}x1`]);
   for(const shape of shapes)for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.02'],['-t','0.05']],[[],['-ss','0.02','-t','0.05']],[['-ss','0.03'],['-ss','0.01','-t','0.07','-frames:v','1']]] as const){
    const before=['-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${sw}x${sh}`,'-framerate','25',...inputTime],after=['-s:v:0',shape,'-pix_fmt',pixelFormat,...outputTime,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return sink.output;}},backend:createMediaBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
    const result=await frontend.exec([...before,'-i','/input.raw',...after,'/out']);const label=`${pixelFormat}/${sw}x${sh}/${shape}/${seedValue}/${inputTime}/${outputTime}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()).equals(expected),label).toBe(true);cases++;
   }
  }
  expect(cases).toBe(3248);
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native RGB alpha endpoints through fixed point expansion and resizing',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-rgb-alpha-'));let count=0;
 try{
  for(const format of ['rgba','bgra','argb','abgr'])for(const alpha of [0,1,127,128,254,255])for(const [width,height]of [[13,7],[2,2]]){
   const data=Uint8Array.from({length:60},(_,i)=>(i*37+13)&255),offset=format.indexOf('a');for(let i=offset;i<data.length;i+=4)data[i]=alpha;writeFileSync(join(root,'input.raw'),data);
   const frame=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width:5,height:3},{maxFrameBytes:4096}),output=resizeVideoFrame(frame,width!,height!,{maxFrameBytes:4096,maxStateBytes:pixelResizeStateBytes(format,5,3,width!,height!)});
   for(const cpu of [[],['-cpuflags','0']]){const native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...cpu,'-f','rawvideo','-pixel_format',format,'-video_size','5x3','-i',join(root,'input.raw'),'-s',`${width}x${height}`,'-pix_fmt',format,'-f','rawvideo','-']);expect(Buffer.concat(output.planes),`${format}/${alpha}/${width}x${height}/${cpu}`).toEqual(native);count++;}
  }
  expect(count).toBe(96);
 }finally{rmSync(root,{recursive:true,force:true});}
});
