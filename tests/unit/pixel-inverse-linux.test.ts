import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {convertVideoFrame,pixelConversionStateBytes} from '@edge-ffmpeg/swscale';
const fixture=JSON.parse(readFileSync('compat/behavior-specs/inverse-linux-x64-expanded.json','utf8')) as {cases:{id:string;source:string;destination:string;width:number;height:number;inputSha256:string;native:{default:string;scalar:string}}[]};
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
it('matches all 560 recorded native Linux default and independent scalar inverse pixel cases',()=>{
 expect(fixture.cases).toHaveLength(560);
 for(const item of fixture.cases){
  let seed=53;const data=Uint8Array.from({length:pixelLayout(item.source,item.width,item.height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});expect(hash(data),item.id).toBe(item.inputSha256);
  const frame=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:item.source,width:item.width,height:item.height},{maxFrameBytes:65536});
  for(const arithmetic of ['x86_64','scalar'] as const){
   const converted=convertVideoFrame(frame,item.destination,{arithmetic,maxFrameBytes:65536,maxStateBytes:65536});
   expect(hash(Buffer.concat(converted.planes)),`${item.id}/${arithmetic}`).toBe(item.native[arithmetic==='x86_64'?'default':'scalar']);
  }
 }
});
it('budgets Linux MMXEXT state and cancellation independently of the AArch64 rejection policy',()=>{
 const state=pixelConversionStateBytes('nv12','bgra',16,7,'x86_64'),data=new Uint8Array(pixelLayout('nv12',16,7).bytes).fill(128);
 const frame=decodeRawVideo({streamIndex:0,data,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'nv12',width:16,height:7},{maxFrameBytes:65536});
 expect(state).toBeGreaterThan(0);expect(()=>convertVideoFrame(frame,'bgra',{arithmetic:'x86_64',maxFrameBytes:65536,maxStateBytes:state-1})).toThrow('state');
 expect(()=>convertVideoFrame(frame,'bgra',{arithmetic:'x86_64',maxFrameBytes:65536,maxStateBytes:state,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
 expect(pixelConversionStateBytes('nv12','bgra',16,6,'x86_64')).toBeGreaterThan(0);
});
