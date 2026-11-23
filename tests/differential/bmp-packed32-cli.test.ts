import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend as createBmpBackend} from '@edge-ffmpeg/avformat';import {encodeBmp} from '@edge-ffmpeg/avcodec';import {verifyBmpReference} from '../helpers/bmp-corpus.js';verifyBmpReference();
it('matches native BMP encoding format negotiation for packed 32-bit inputs',async()=>{
 const masks=[[4278190080,16711680,65280],[16711680,65280,255],[65280,16711680,4278190080],[255,65280,16711680]],failures:unknown[]=[];
 for(const rgb of [...masks,null])for(const alpha of [false,true]){
  const pixels=Uint8Array.from({length:36},(_,i)=>(i*17+13)%256),base=encodeBmp({width:3,height:3,pixelFormat:'bgra',planes:[pixels],linesizes:[12],pts:null,metadata:{}},{maxFrameBytes:4096,maxPacketBytes:4096}).data,input=rgb?new Uint8Array(base.length+68):base.slice(),v=new DataView(input.buffer);
  if(rgb){input.set(base.subarray(0,54));input.set(base.subarray(54),122);v.setUint32(2,input.length,true);v.setUint32(10,122,true);v.setUint32(14,108,true);v.setUint32(30,3,true);rgb.forEach((m,i)=>v.setUint32(54+i*4,m,true));v.setUint32(66,alpha?1:0,true);}
  else if(!alpha)for(let i=57;i<input.length;i+=4)input[i]=0;

  const parts:Uint8Array[]=[],api=new FFmpeg({backend:createBmpBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(chunk){parts.push(chunk.slice());},async commit(){},async abort(){parts.length=0;}};}}}),result=await api.exec(['-f','image2pipe','-c:v','bmp','-i','/input','-c:v','bmp','-f','image2pipe','/output']),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-c:v','bmp','-f','image2pipe','pipe:1'],{input,timeout:5000});
  expect(native.status,String(native.stderr)).toBe(0);if(result.exitCode!==0||!Buffer.concat(parts).equals(native.stdout))failures.push({rgb,alpha,result:result.diagnostics,nativeDepth:native.stdout.readUInt16LE(28),nativePixels:Array.from(native.stdout.subarray(54,66))});
 }
 expect(failures).toEqual([]);
});
