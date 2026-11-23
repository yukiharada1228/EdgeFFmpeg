import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';import {convertVideoFrame,pixelConversionStateBytes,resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native legacy JPEG-range planar input without losing implicit range metadata',()=>{
 verifyH264Reference();let checked=0;
 for(const format of ['yuvj420p','yuvj422p','yuvj444p'])for(const [width,height]of [[18,4],[17,5]])for(const colorRange of [undefined,1,2]){
  const layout=pixelLayout(videoStoragePixelFormat(format),width!,height!);let seed=53;const data=Uint8Array.from({length:layout.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}),metadata={tag:'legacy-source',...(colorRange===undefined?{}:{colorRange})},frame={width:width!,height:height!,pixelFormat:format,planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata};
  for(const output of ['rgb24','gbrp'])for(const arithmetic of ['aarch64','scalar'] as const)for(const resized of [false,true]){
   const dw=resized?13:width!,dh=resized?7:height!,state=resized?pixelResizeStateBytes(format,width!,height!,dw,dh,output,arithmetic):pixelConversionStateBytes(format,output,width!,height!,arithmetic),actual=resized?resizeVideoFrame(frame,dw,dh,{maxFrameBytes:65536,maxStateBytes:state,arithmetic,outputPixelFormat:output}):convertVideoFrame(frame,output,{maxFrameBytes:65536,maxStateBytes:state,arithmetic});
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,...(colorRange===undefined?[]:['-color_range',colorRange===1?'tv':'pc']),'-i','pipe:0','-vf',`scale=${dw}:${dh}`,'-pix_fmt',output,'-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:65536});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.concat(actual.planes).equals(native.stdout),`${format}/${width}x${height}/${output}/${arithmetic}/${resized}`).toBe(true);expect(actual.metadata.colorRange).toBe(2);expect(metadata).toEqual({tag:'legacy-source',...(colorRange===undefined?{}:{colorRange})});checked++;
  }
 }expect(checked).toBe(144);verifyH264Reference();
},180000);

it('matches native legacy JPEG-range input through spatial and RGB filter stages',()=>{
 verifyH264Reference();let checked=0;
 for(const format of ['yuvj420p','yuvj422p','yuvj444p'])for(const [width,height]of [[18,4],[17,5]]){
  const layout=pixelLayout(videoStoragePixelFormat(format),width!,height!),data=Uint8Array.from({length:layout.bytes},(_,i)=>(i*71+23)&255),metadata={tag:'legacy-graph'},frame={width:width!,height:height!,pixelFormat:format,planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata};
  for(const arithmetic of ['aarch64','scalar']as const){const filter='hflip,transpose=1,scale=13:7,format=rgb24',plan=compileVideoFilterChain(filter).plan(format,width!,height!,{arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes,arithmetic}),native=spawnSync('.build/reference/ffmpeg',['-v','error',...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-i','pipe:0','-vf',filter,'-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:65536});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.concat(actual.planes).equals(native.stdout),`${format}/${width}x${height}/${arithmetic}`).toBe(true);expect(actual.metadata.colorRange).toBe(2);expect(metadata).toEqual({tag:'legacy-graph'});checked++;}
 }expect(checked).toBe(12);verifyH264Reference();
},180000);
