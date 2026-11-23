import {expect,it} from 'vitest';
import {canConvertPixelFormat,convertVideoFrame,PixelConversionError} from '@edge-ffmpeg/swscale';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
function frame(pixelFormat:string,width=1,height=1){const layout=pixelLayout(pixelFormat,width,height);return decodeRawVideo({streamIndex:0,data:Uint8Array.from({length:layout.bytes},(_,i)=>i+1),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat,width,height},{maxFrameBytes:4096});}
it('reorders packed and planar RGB components with alpha preservation and independently owned output',()=>{
 const input=frame('rgba');input.planes[0]!.set([1,23,45,67]);input.metadata={tag:'source'};
 const argb=convertVideoFrame(input,'argb',{maxFrameBytes:64}),planar=convertVideoFrame(input,'gbrp',{maxFrameBytes:64});expect([...argb.planes[0]!]).toEqual([67,1,23,45]);expect(planar.planes.map(value=>[...value])).toEqual([[23],[45],[1]]);expect(argb.pts).toEqual(input.pts);expect(argb.pts).not.toBe(input.pts);expect(argb.metadata).toEqual(input.metadata);expect(argb.metadata).not.toBe(input.metadata);expect(argb.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 expect([...convertVideoFrame(planar,'bgra',{maxFrameBytes:64}).planes[0]!]).toEqual([45,23,1,255]);input.planes[0]!.fill(0);expect([...argb.planes[0]!]).toEqual([67,1,23,45]);
});
it('deinterleaves odd-sized padded NV21 rows and supplies opaque alpha without reading padding',()=>{
 const input=frame('nv21',5,3),luma=input.planes[0]!.slice(),chroma=input.planes[1]!.slice();input.planes=input.planes.map((plane,index)=>{const rowBytes=input.linesizes[index]!,height=index===0?3:2,padded=new Uint8Array((rowBytes+3)*height).fill(250);for(let row=0;row<height;row++)padded.set(plane.subarray(row*rowBytes,(row+1)*rowBytes),row*(rowBytes+3));return padded;});input.linesizes=input.linesizes.map(value=>value+3);
 const output=convertVideoFrame(input,'yuva420p',{maxFrameBytes:128});expect(output.linesizes).toEqual([5,3,3,5]);expect(output.planes.map(plane=>plane.byteOffset)).toEqual([0,15,21,27]);expect(output.planes[0]).toEqual(luma);expect([...output.planes[1]!]).toEqual([...chroma].filter((_,i)=>i%2===1));expect([...output.planes[2]!]).toEqual([...chroma].filter((_,i)=>i%2===0));expect([...output.planes[3]!]).toEqual(Array(15).fill(255));
 const roundtrip=convertVideoFrame(output,'nv21',{maxFrameBytes:128});expect(roundtrip.planes[1]).toEqual(chroma);
});
it('copies every supported identity layout into tight owned planes and preserves unknown timestamps',()=>{
 for(const pixel of ['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuv420p','yuva420p','nv12','nv21','yuv422p','yuv444p']){
  const input={...frame(pixel,5,3),pts:null},output=convertVideoFrame(input,pixel==='gray'?'gray8':pixel,{maxFrameBytes:4096});expect(output.pts).toBeNull();expect(output.planes).toEqual(input.planes);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 }
 expect(canConvertPixelFormat('gray8','gray')).toBe(true);expect(canConvertPixelFormat('rgba','__proto__')).toBe(false);expect(canConvertPixelFormat('rgba','yuv420p')).toBe(true);
});
it('rejects malformed plane storage conversion families budgets and cancellation before returning a frame',()=>{
 const input=frame('rgba',2,2);
 for(const changed of [{...input,planes:[]},{...input,linesizes:[7]},{...input,linesizes:[-8]},{...input,planes:[new Uint8Array(15)]},{...input,pts:{value:0n,timeBase:{num:1n,den:0n}}}])expect(()=>convertVideoFrame(changed,'bgra',{maxFrameBytes:64})).toThrow(PixelConversionError);
 expect(()=>convertVideoFrame({...input,planes:[new Uint8Array(65)]},'bgra',{maxFrameBytes:64})).toThrow('aggregate');expect(()=>convertVideoFrame(input,'bgra',{maxFrameBytes:15})).toThrow('allocation');expect(()=>convertVideoFrame(frame('rgb24',2,2),'rgba',{maxFrameBytes:12})).toThrow('allocation');expect(()=>convertVideoFrame(input,'unknown',{maxFrameBytes:64})).toThrow('Unsupported');expect(()=>convertVideoFrame(input,'bgra',{maxFrameBytes:64,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
});
it('preflights expanded video output and simultaneous conversion payloads before opening input or output',async()=>{
 for(const budget of [{maxResidentBytes:4096,maxBufferBytes:27},{maxResidentBytes:300,maxBufferBytes:64}]){
  let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('unexpected input');},async openWrite(){opens++;return collectingOutput().output;}},backend:createMediaBackend(),budget:{...budget,maxPendingPackets:2,maxCpuTimeMs:1000}});
  const result=await frontend.exec(['-f','rawvideo','-s','5x3','-pix_fmt','yuv420p','-i','/in','-pix_fmt','yuva420p','-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
 }
});
it('honors converted frame backpressure and aborts staged output on conversion-path write failures',async()=>{
 let reads=0,release=()=>{},notify=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),blocked=new Promise<void>(resolve=>{notify=resolve;}),sink=collectingOutput();
 const frontend=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(_offset,length){reads++;return new Uint8Array(length).fill(7);}};},async openWrite(){return {...sink.output,async write(data){notify();await gate;await sink.output.write(data);}};}},backend:createMediaBackend(),budget:{maxResidentBytes:128,maxBufferBytes:16,maxPendingPackets:2,maxCpuTimeMs:1000}});
 const work=frontend.exec(['-f','rawvideo','-s','1x1','-pix_fmt','rgb24','-i','/in','-pix_fmt','rgba','-f','rawvideo','/out']);await blocked;expect(reads).toBe(1);release();expect((await work).exitCode).toBe(0);expect(sink.bytes()).toEqual(new Uint8Array([7,7,7,255,7,7,7,255]));
 const failed=collectingOutput(),broken=new FFmpeg({filesystem:{async openRead(){return {size:3n,async readAt(){return new Uint8Array(3);}};},async openWrite(){return {...failed.output,async write(){throw new Error('disk failed');}};}},backend:createMediaBackend()});expect((await broken.exec(['-f','rawvideo','-s','1x1','-pix_fmt','rgb24','-i','/in','-pix_fmt','rgba','-f','rawvideo','/out'])).exitCode).toBe(1);expect(failed.aborted).toBe(true);expect(failed.committed).toBe(false);
});
