import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend as createBmpBackend} from '@edge-ffmpeg/avformat';
import {encodeBmp} from '@edge-ffmpeg/avcodec';
import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('matches native image2pipe decode, encode and copy commands through public FFmpeg API',async()=>{
 let jobs=0;
 for(const pixelFormat of ['bgr24','bgra','rgb555le','gray','pal8']){
  const parts:Uint8Array[]=[];
  for(let frame=0;frame<3;frame++){
   const step=pixelFormat==='bgr24'?3:pixelFormat==='bgra'?4:pixelFormat==='rgb555le'?2:1,pixels=Uint8Array.from({length:3*3*step},(_,i)=>(i*29+frame*37+43)%256),palette=Uint8Array.from({length:1024},(_,i)=>(i*13+27)%256);
   parts.push(encodeBmp({width:3,height:3,pixelFormat,planes:pixelFormat==='pal8'?[pixels,palette]:[pixels],linesizes:pixelFormat==='pal8'?[3,1024]:[3*step],pts:null,metadata:{}},{maxFrameBytes:8192,maxPacketBytes:8192}).data);
  }
  const input=Buffer.concat(parts);
  for(const codec of ['copy','rawvideo','bmp'])for(const limit of [null,0,1,2])for(const rate of ['25','30000/1001']){
   const output:Uint8Array[]=[],format=codec==='rawvideo'?'rawvideo':'image2pipe',options=['-c:v',codec,...(limit===null?[]:['-frames:v',String(limit)]),'-f',format];let committed=false;
   const api=new FFmpeg({backend:createBmpBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:8192,maxPendingPackets:1,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+Math.min(length,3));}};},async openWrite(){return {async write(chunk){output.push(chunk.slice());},async commit(){committed=true;},async abort(){output.length=0;}};}}});
   const result=await api.exec(['-f','image2pipe','-framerate',rate,'-c:v','bmp','-i','/input',...options,'/output']),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-framerate',rate,'-c:v','bmp','-i','pipe:0',...options,'pipe:1'],{input,timeout:5000});
   expect(native.status,String(native.stderr)).toBe(0);expect(result.exitCode,String(result.diagnostics.map(d=>d.message))).toBe(0);expect(committed).toBe(true);expect(Buffer.concat(output),String([pixelFormat,codec,limit,rate])).toEqual(native.stdout);jobs++;
  }
 }
 expect(jobs).toBe(120);
});
