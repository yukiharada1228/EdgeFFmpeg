import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native aligned and scalar filter coefficients for large planar and semiplanar reductions',()=>{
 verifyH264Reference();let checked=0;
 for(const format of ['yuv420p','nv12','nv21'])for(const [sw,sh,dw,dh]of [[320,178,17,9],[1918,1078,48,32],[1918,1078,95,67]]){
  const source=pixelLayout(format!,sw!,sh!);let seed=73;const data=Uint8Array.from({length:source.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
  const frame={width:sw!,height:sh!,pixelFormat:format!,planes:source.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:source.planes.map(p=>p.rowBytes),pts:null,metadata:{}};
  for(const arithmetic of ['aarch64','scalar'] as const){
   const state=pixelResizeStateBytes(format!,sw!,sh!,dw!,dh!,format!,arithmetic),actual=resizeVideoFrame(frame,dw!,dh!,{maxFrameBytes:4194304,maxStateBytes:state,arithmetic});
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...(arithmetic==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',format!,'-video_size',`${sw}x${sh}`,'-i','pipe:0','-s',`${dw}x${dh}`,'-pix_fmt',format!,'-f','rawvideo','pipe:1'],{input:data,timeout:15000,maxBuffer:4194304});
   expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.concat(actual.planes).equals(native.stdout),`${format}/${sw}x${sh}/${dw}x${dh}/${arithmetic}`).toBe(true);checked++;
  }
 }expect(checked).toBe(18);verifyH264Reference();
},180000);
