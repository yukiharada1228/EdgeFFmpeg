import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {convertVideoFrame,pixelConversionStateBytes,resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native full-range matrix profiles through table, filtered, SIMD and resized YUV to RGB paths',()=>{
 verifyH264Reference();let checked=0;
 for(const source of ['yuv420p','yuv422p','yuv444p','nv12','nv21'])for(const [matrix,name] of [[0,'bt601'],[1,'bt709'],[2,'bt601'],[4,'fcc'],[5,'bt601'],[6,'bt601'],[7,'smpte240m'],[9,'bt2020']] as const)for(const [sw,sh] of [[16,4],[18,4],[17,5],[96,64]] as const){
  const layout=pixelLayout(source,sw,sh);let seed=matrix*37;const data=Uint8Array.from({length:layout.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
  const frame={width:sw,height:sh,pixelFormat:source,planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata:{colorSpace:matrix,colorRange:2}};
  for(const output of ['rgb24','bgra','argb','gbrp'])for(const arithmetic of ['aarch64','scalar'] as const)for(const resize of [false,true]){
   if(!resize&&arithmetic==='aarch64'&&['nv12','nv21'].includes(source)&&sw%16===0&&sh%2===0)continue;
   const dw=resize?13:sw,dh=resize?7:sh,state=resize?pixelResizeStateBytes(source,sw,sh,dw,dh,output,arithmetic):pixelConversionStateBytes(source,output,sw,sh,arithmetic);
   const actual=resize?resizeVideoFrame(frame,dw,dh,{maxFrameBytes:1048576,maxStateBytes:state,outputPixelFormat:output,arithmetic}):convertVideoFrame(frame,output,{maxFrameBytes:1048576,maxStateBytes:state,arithmetic});
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${sw}x${sh}`,'-i','pipe:0','-vf',`scale=${dw}:${dh}:in_range=full:in_color_matrix=${name}`,'-pix_fmt',output,'-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:1048576});
   expect(actual.metadata).toEqual({colorSpace:0,colorRange:2});expect(frame.metadata).toEqual({colorSpace:matrix,colorRange:2});
   expect(native.status,String(native.stderr)).toBe(0);const bytes=Buffer.concat(actual.planes);expect(bytes.equals(native.stdout),`${source}/${matrix}/${sw}x${sh}/${output}/${arithmetic}/${resize} first=${bytes.findIndex((v,i)=>v!==native.stdout[i])}`).toBe(true);checked++;
  }
 }expect(checked).toBe(2432);verifyH264Reference();
},180000);
