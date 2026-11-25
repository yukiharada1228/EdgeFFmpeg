import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {convertVideoFrame,pixelConversionStateBytes,resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native limited-range matrix profiles through table, filtered, SIMD and resized YUV to RGB paths',()=>{
 verifyH264Reference();const defaultArithmetic=referencePixelArithmetic();let checked=0;
 for(const source of ['yuv420p','yuv422p','yuv444p','nv12','nv21'])for(const [matrix,name] of [[0,'bt601'],[1,'bt709'],[2,'bt601'],[4,'fcc'],[5,'bt601'],[6,'bt601'],[7,'smpte240m'],[9,'bt2020']] as const)for(const [sw,sh] of [[16,4],[18,4],[17,5],[96,64]] as const){
  const layout=pixelLayout(source,sw,sh);let seed=matrix*37;const data=Uint8Array.from({length:layout.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
  const frame={width:sw,height:sh,pixelFormat:source,planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata:{colorSpace:matrix,colorRange:1}};
  for(const output of ['rgb24','bgra','argb','gbrp'])for(const arithmetic of [defaultArithmetic,'scalar'] as const)for(const resize of [false,true]){
   if(!resize&&arithmetic==='aarch64'&&['nv12','nv21'].includes(source)&&sw%16===0&&sh%2===0)continue;
   const dw=resize?13:sw,dh=resize?7:sh,state=resize?pixelResizeStateBytes(source,sw,sh,dw,dh,output,arithmetic):pixelConversionStateBytes(source,output,sw,sh,arithmetic);
   const actual=resize?resizeVideoFrame(frame,dw,dh,{maxFrameBytes:1048576,maxStateBytes:state,outputPixelFormat:output,arithmetic}):convertVideoFrame(frame,output,{maxFrameBytes:1048576,maxStateBytes:state,arithmetic});
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${sw}x${sh}`,'-i','pipe:0','-vf',`scale=${dw}:${dh}:in_color_matrix=${name}`,'-pix_fmt',output,'-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:1048576});
   expect(actual.metadata).toEqual({colorSpace:0,colorRange:2});expect(frame.metadata).toEqual({colorSpace:matrix,colorRange:1});
   expect(native.status,String(native.stderr)).toBe(0);const bytes=Buffer.concat(actual.planes);expect(bytes.equals(native.stdout),`${source}/${matrix}/${sw}x${sh}/${output}/${arithmetic}/${resize} first=${bytes.findIndex((v,i)=>v!==native.stdout[i])}`).toBe(true);checked++;
  }
 }expect(checked).toBe(defaultArithmetic==='aarch64'?2432:2560);verifyH264Reference();
},180000);
it('updates matrix metadata across RGB and YUV stages without changing borrowed input metadata',()=>{
 verifyH264Reference();const layout=pixelLayout('yuv420p',18,6),data=Uint8Array.from({length:layout.bytes},(_,i)=>(i*73+29)&255),metadata={colorSpace:1,colorRange:1,tag:'owned-source'};
 const original={width:18,height:6,pixelFormat:'yuv420p',planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata};let frame:VideoFrameData=original;
 for(const format of ['rgb24','yuv420p','rgb24']){
  const state=pixelConversionStateBytes(frame.pixelFormat,format,18,6,'scalar');frame=convertVideoFrame(frame,format,{maxFrameBytes:1048576,maxStateBytes:state,arithmetic:'scalar'});
  expect(frame.metadata.colorSpace).toBe(format==='rgb24'?0:2);expect(frame.metadata.colorRange).toBe(format==='rgb24'?2:1);expect(frame.metadata.tag).toBe('owned-source');expect(frame.metadata).not.toBe(metadata);
 }
 expect(metadata).toEqual({colorSpace:1,colorRange:1,tag:'owned-source'});
 const native=spawnSync('.build/reference/ffmpeg',['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format','yuv420p','-video_size','18x6','-i','pipe:0','-vf','scale=in_color_matrix=bt709,format=rgb24,scale=out_color_matrix=bt601,format=yuv420p,scale=in_color_matrix=bt601,format=rgb24','-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:1048576});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.concat(frame.planes).equals(native.stdout)).toBe(true);verifyH264Reference();
});

it('preserves full-range YUV luma when converting and resizing to full-range gray',()=>{
 verifyH264Reference();const source=pixelLayout('yuv420p',64,4),data=Uint8Array.from({length:source.bytes},(_,i)=>i<256?i:(i*71)&255),frame={width:64,height:4,pixelFormat:'yuv420p',planes:source.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:source.planes.map(p=>p.rowBytes),pts:null,metadata:{colorSpace:1,colorRange:2}};
 for(const [dw,dh]of [[64,4],[17,7]]){
  const options={maxFrameBytes:4096,maxStateBytes:4096,arithmetic:'scalar' as const,outputPixelFormat:'gray'},actual=dw===64?convertVideoFrame(frame,'gray',options):resizeVideoFrame(frame,dw!,dh!,options);
  const native=spawnSync('.build/reference/ffmpeg',['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format','yuv420p','-video_size','64x4','-i','pipe:0','-vf',`scale=${dw}:${dh}:in_range=full`,'-pix_fmt','gray','-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:4096});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.concat(actual.planes).equals(native.stdout)).toBe(true);
 }
 verifyH264Reference();
});
