import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {collectingOutput} from '../helpers/output.js';
it('matches 4480 locked Linux default and scalar multi-frame time and framecrc outputs',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/inverse-linux-time.json','utf8')) as {cases:{id:string;inputSha256:string;sha256:string}[]};
 expect(fixture.cases).toHaveLength(4480);expect(new Set(fixture.cases.map(item=>item.id)).size).toBe(4480);
 const geometries=new Set(['1x1','2x2','3x2','3x3','5x3','6x4','8x6','16x6','17x9','32x8','33x32','127x65','5x7','16x7','16x5','6x7']);
 const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex'),inputs=new Map<string,Uint8Array>();
 for(const item of fixture.cases){
  const match=/^(yuv420p|yuva420p|yuv422p|nv12|nv21)-(rgb24|bgr24|rgba|bgra|argb|abgr|gbrp)-(\d+)x(\d+)-(x86_64|scalar)-(timed|all)-(rawvideo|framecrc)$/.exec(item.id);
  expect(match,item.id).not.toBeNull();const [,source,destination,w,h,profile,selection,format]=match!,width=Number(w),height=Number(h),key=`${source}/${w}/${h}`;
  expect(geometries.has(`${w}x${h}`),item.id).toBe(true);
  if(!inputs.has(key)){let seed=53;inputs.set(key,Uint8Array.from({length:pixelLayout(source!,width,height).bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}));}
  const data=inputs.get(key)!;expect(hash(data),item.id).toBe(item.inputSha256);const sink=collectingOutput();let reads=0;
  const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){
   if(++reads>15000||offset<0n||length<1||length>65536||offset+BigInt(length)>BigInt(data.length))throw new Error('Read exceeds finite fixture bounds');
   return data.slice(Number(offset),Number(offset)+Math.min(length,11));
  }};},async openWrite(){return sink.output;}},backend:createMediaBackend({pixelArithmetic:profile as 'x86_64'|'scalar'}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
  const result=await frontend.exec([...(profile==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source!,'-video_size',`${width}x${height}`,'-framerate','25','-i','/input.raw','-pix_fmt',destination!,...(selection==='timed'?['-ss','0.02','-t','0.05']:[]),'-bitexact','-f',format!,'/output.out']);
  expect(result.exitCode,`${item.id}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(sink.committed,item.id).toBe(true);expect(reads,item.id).toBeGreaterThan(0);expect(hash(sink.bytes()),item.id).toBe(item.sha256);
 }
},60000);
