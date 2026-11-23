import {createNativeOracle,runBoundedCases} from '../helpers/native-oracle.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {resizeVideoFrame,pixelResizeStateBytes,canResizePixelFormat} from '@edge-ffmpeg/swscale';
const formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'];
it('matches native fused resize and format conversion across 196 supported format pairs',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-fused-bounded-')),arithmeticDefault=referencePixelArithmetic(),oracle=createNativeOracle();let count=0,pairs=0;
 function* cases(){let id=0;for(const source of formats)for(const destination of formats){if(!canResizePixelFormat(source,destination))continue;pairs++;
  for(const[sw,sh]of [[5,3],[6,4],[17,9],[64,33]] as const)for(const[dw,dh]of [[1,1],[2,2],[3,1],[4,3],[5,7],[sw*4,sh*3]])for(const seedValue of [0,197])yield {id:id++,source,destination,sw,sh,dw:dw!,dh:dh!,seedValue};
 }}
 try{const completed=await runBoundedCases(cases(),2,signal,async(job,caseSignal)=>{
  const {id,source,destination,sw,sh,dw,dh,seedValue}=job;let seed=seedValue;
  const data=Uint8Array.from({length:pixelLayout(source,sw,sh).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}),input=join(root,id+'.raw');writeFileSync(input,data);
  try{const frame=decodeRawVideo({streamIndex:0,data,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:sw,height:sh},{maxFrameBytes:524288});
   for(const cpu of [[],['-cpuflags','0']]){const arithmetic=cpu.length?'scalar':arithmeticDefault,output=resizeVideoFrame(frame,dw,dh,{outputPixelFormat:destination,arithmetic,maxFrameBytes:524288,maxStateBytes:pixelResizeStateBytes(source,sw,sh,dw,dh,destination,arithmetic)});
    const native=await oracle.run(resolve('.build/reference/ffmpeg'),['-v','error',...cpu,'-f','rawvideo','-pixel_format',source,'-video_size',`${sw}x${sh}`,'-i',input,'-s',`${dw}x${dh}`,'-pix_fmt',destination,'-f','rawvideo','-'],caseSignal);
    expect(Buffer.concat(output.planes),`${source}/${destination}/${sw}x${sh}/${dw}x${dh}/${seedValue}/${cpu}`).toEqual(native);expect(output.pts).toEqual(frame.pts);count++;
   }
  }finally{unlinkSync(input);}
 });expect(completed).toBe(9408);expect(pairs).toBe(196);expect(count).toBe(18816);expect(oracle.metrics).toEqual({calls:18816,active:0,peak:2,failures:0});
 }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches fused rawvideo CLI time selection and complete framecrc outputs for all supported pairs',async()=>{
 const {FFmpeg}=await import('@edge-ffmpeg/core'),{createMediaBackend}=await import('@edge-ffmpeg/avformat'),{collectingOutput}=await import('../helpers/output.js'),root=mkdtempSync(join(tmpdir(),'edge-fused-cli-')),defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const destination of formats){
   if(!canResizePixelFormat(source,destination))continue;
   for(const [sw,sh,dw,dh]of [[5,3,13,7],[8,6,3,2],[17,9,1,1]]){
    let seed=73;const data=Uint8Array.from({length:pixelLayout(source,sw!,sh!).bytes*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),data);
    for(const format of ['rawvideo','framecrc'])for(const [beforeTime,afterTime]of [[[],[]],[['-ss','0.02'],['-t','0.05']],[[],['-ss','0.02','-t','0.05']],[['-ss','0.03'],['-ss','0.01','-t','0.07','-frames:v','1']]]){
     const before=['-f','rawvideo','-pixel_format',source,'-s',`${sw}x${sh}`,...beforeTime!],after=['-s',`${dw}x${dh}`,'-pix_fmt',destination,...afterTime!,'-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput(),frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return sink.output;}},backend:createMediaBackend({pixelArithmetic:defaultArithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
     const result=await frontend.exec([...before,'-i','/input.raw',...after,'/out']);expect(result.exitCode,JSON.stringify({source,destination,sw,sh,dw,dh,format,result})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${destination}/${sw}x${sh}/${dw}x${dh}/${beforeTime}/${afterTime}/${format}`).toEqual(native);count++;
    }
   }
  }
  expect(count).toBe(4704);
 }finally{rmSync(root,{recursive:true,force:true});}
},90000);
it('matches resized inverse profiles at tiny inputs and aligned semiplanar boundaries',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-inverse-tiny-')),defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of ['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'])for(const destination of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [sw,sh]of [[1,1],[2,2],[3,3],[16,6]] as const)for(const [dw,dh]of [[2,3],[4,3],[5,7],[sw*2,sh],[sw,sh*2],[1,1]]){
   if(sw===dw&&sh===dh)continue;
   for(const seedValue of [53,197]){
    let seed=seedValue;const input=Uint8Array.from({length:pixelLayout(source,sw,sh).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
    const frame=decodeRawVideo({streamIndex:0,data:input,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:sw,height:sh},{maxFrameBytes:4096});
    for(const cpu of [[],['-cpuflags','0']]){
     const arithmetic=cpu.length?'scalar':defaultArithmetic,output=resizeVideoFrame(frame,dw!,dh!,{outputPixelFormat:destination,arithmetic,maxFrameBytes:4096,maxStateBytes:pixelResizeStateBytes(source,sw,sh,dw!,dh!,destination,arithmetic)}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...cpu,'-f','rawvideo','-pixel_format',source,'-s',`${sw}x${sh}`,'-i',join(root,'input.raw'),'-s',`${dw}x${dh}`,'-pix_fmt',destination,'-f','rawvideo','-']);
     expect(Buffer.concat(output.planes),`${source}/${destination}/${sw}x${sh}/${dw}x${dh}/${seedValue}/${cpu}`).toEqual(native);count++;
    }
   }
  }
  expect(count).toBe(3864);
 }finally{rmSync(root,{recursive:true,force:true});}
},90000);
