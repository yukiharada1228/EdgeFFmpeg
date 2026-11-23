import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
it('matches native default and scalar bicubic gray resizing across arbitrary-ratio tiny odd and large supports',()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-gray-resize-'));let cases=0;
 try{
  for(const [sw,sh]of [[1,1],[2,2],[3,3],[5,3],[6,4],[8,6],[17,9],[64,33],[128,65]] as const){
   const shapes=new Set([[sw,sh],[sw*2,sh*2],[Math.ceil(sw/2),Math.ceil(sh/2)],[sw,sh*2],[sw*2,sh],[1,1],[2,2],[3,1],[4,3],[5,7],[sw*4,sh*3],[sw*4,1]].map(([w,h])=>`${w}x${h}`));
   for(const seedValue of [0,73,197]){
    let seed=seedValue;const data=Uint8Array.from({length:sw*sh},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.gray'),data);
    for(const shape of shapes){
     const [dw,dh]=shape.split('x').map(Number) as [number,number];
     const input:VideoFrameData={width:sw,height:sh,pixelFormat:'gray',planes:[data],linesizes:[sw],pts:null,metadata:{}},state=pixelResizeStateBytes('gray',sw,sh,dw,dh),output=resizeVideoFrame(input,dw,dh,{maxFrameBytes:262144,maxStateBytes:state});
     for(const cpu of [[],['-cpuflags','0']]){
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...cpu,'-f','rawvideo','-pixel_format','gray','-video_size',`${sw}x${sh}`,'-i',join(root,'input.gray'),'-s',shape,'-pix_fmt','gray','-f','rawvideo','-']);
      expect(Buffer.from(output.planes[0]!).equals(expected),`${sw}x${sh}/${shape}/${seedValue}/${cpu}`).toBe(true);cases++;
     }
    }
   }
  }
  expect(cases).toBe(600);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native gray output-size time selection framecrc aliases and ignored streamcopy sizes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-gray-resize-cli-'));let cases=0;
 async function compare(data:Uint8Array,sw:number,sh:number,before:readonly string[],after:readonly string[]){
  writeFileSync(join(root,'input.gray'),data);
  const source=['-f','rawvideo','-pixel_format','gray','-video_size',`${sw}x${sh}`,'-framerate','25',...before],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...source,'-i',join(root,'input.gray'),...after,'-']),sink=collectingOutput();
  const frontend=new FFmpeg({filesystem:{async openRead(){return {size:BigInt(data.length),async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(){return sink.output;}},backend:createMediaBackend(),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});
  const result=await frontend.exec([...source,'-i','/input.gray',...after,'/output']);expect(result.exitCode,JSON.stringify({sw,sh,before,after,diagnostics:result.diagnostics})).toBe(0);expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()).equals(expected),JSON.stringify({sw,sh,before,after})).toBe(true);cases++;
 }
 try{
  for(const [sw,sh]of [[1,1],[3,2],[5,3],[8,6],[17,9],[64,33]] as const)for(const seedValue of [73,197]){
   let seed=seedValue;const data=Uint8Array.from({length:sw*sh*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}),shapes=new Set(['1x1','2x2','5x7',`${sw*2}x${sh*2}`,`${sw*4}x1`]);
   for(const shape of shapes)for(const format of ['rawvideo','framecrc'])for(const [before,selection]of [[[],[]],[['-ss','0.02'],['-t','0.05']],[[],['-ss','0.02','-t','0.05']],[['-ss','0.03'],['-ss','0.01','-t','0.07','-frames:v','1']]] as const)await compare(data,sw,sh,before,['-s',shape,...selection,'-bitexact','-f',format]);
  }
  const data=Uint8Array.from({length:60},(_,i)=>(i*37+13)&255);
  for(const alias of ['-s','-s:v','-s:v:0','-s:0'])for(const format of ['rawvideo','framecrc']){
   for(const prefix of [[],['-s','0x0']])await compare(data,5,3,[],[...prefix,alias,'13x7','-bitexact','-f',format]);
   for(const size of ['2x2','bad','0x0','-1x3'])await compare(data,5,3,[],['-c:v','copy',alias,size,'-bitexact','-f',format]);
  }
  for(const format of ['rawvideo','framecrc'])for(const [input,selection]of [[new Uint8Array(),[]],[data,['-frames:v','0']],[data,['-t','0']]] as const)await compare(input,5,3,[],['-s','13x7',...selection,'-bitexact','-f',format]);
  expect(cases).toBe(518);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
