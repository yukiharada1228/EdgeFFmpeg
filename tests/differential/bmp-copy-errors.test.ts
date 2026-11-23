import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend as createBmpBackend} from '@edge-ffmpeg/avformat';import {encodeBmp} from '@edge-ffmpeg/avcodec';import {verifyBmpReference} from '../helpers/bmp-corpus.js';verifyBmpReference();
it('matches Native BMP packet copy without requiring decoder success',async()=>{
 const base=encodeBmp({width:3,height:3,pixelFormat:'bgr24',planes:[new Uint8Array(27)],linesizes:[9],pts:null,metadata:{}},{maxFrameBytes:4096,maxPacketBytes:4096}).data;
 for(const [offset,value,kind]of [[18,0,4],[22,0,4],[26,0,2],[28,0,2],[28,6,2],[30,10,4],[10,5000,4],[28,16,2]] as const){
  const input=base.slice(),view=new DataView(input.buffer);if(kind===2)view.setUint16(offset,value,true);else view.setUint32(offset,value,true);
  const parts:Uint8Array[]=[],api=new FFmpeg({backend:createBmpBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(chunk){parts.push(chunk.slice());},async commit(){},async abort(){parts.length=0;}};}}}),result=await api.exec(['-f','image2pipe','-c:v','bmp','-i','/input','-c:v','copy','-f','image2pipe','/output']),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-c:v','copy','-f','image2pipe','pipe:1'],{input,timeout:5000});
  expect(result.exitCode,String([offset,value])+String(native.stderr)).toBe(native.status===0?0:1);if(native.status===0)expect(Buffer.concat(parts)).toEqual(native.stdout);
 }
});
