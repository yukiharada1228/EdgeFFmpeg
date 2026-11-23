import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {openBmpStream} from '@edge-ffmpeg/containers';
import {encodeBmp} from '@edge-ffmpeg/avcodec';
import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('matches native BMP image2pipe copy packets and integer clocks with bounded short reads',async()=>{
 for(const rate of [{num:25n,den:1n},{num:30000n,den:1001n},{num:7n,den:3n}]){
  const chunks:Uint8Array[]=[];
  for(let i=0;i<5;i++){const pixels=Uint8Array.from({length:27},(_,j)=>(i*31+j*47)%256);chunks.push(encodeBmp({width:3,height:3,pixelFormat:'bgr24',planes:[pixels],linesizes:[9],pts:null,metadata:{}},{maxFrameBytes:4096,maxPacketBytes:4096}).data);}
  const bytes=Buffer.concat(chunks),calls:{offset:bigint;length:number}[]=[],stream=openBmpStream({size:BigInt(bytes.length),async readAt(offset,length){calls.push({offset,length});return bytes.subarray(Number(offset),Number(offset)+Math.min(3,length));}},{frameRate:rate,maxReadBytes:7,maxPacketBytes:4096,maxFrames:10});
  expect(calls).toHaveLength(0);const packets=[];for await(const packet of stream){packets.push(packet);expect(packet.data).toEqual(chunks[packets.length-1]);expect(packet.pts).toBe(BigInt(packets.length-1));expect(packet.timeBase).toEqual({num:rate.den,den:rate.num});}
  expect(packets).toHaveLength(5);expect(calls.every(c=>c.length<=7)).toBe(true);
  const native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-framerate',`${rate.num}/${rate.den}`,'-c:v','bmp','-i','pipe:0','-c:v','copy','-f','image2pipe','pipe:1'],{input:bytes,timeout:5000});expect(native.status,String(native.stderr)).toBe(0);expect(native.stdout).toEqual(Buffer.concat(packets.map(p=>Buffer.from(p.data))));
  const probe=spawnSync('.build/reference/ffprobe',['-v','error','-f','image2pipe','-framerate',`${rate.num}/${rate.den}`,'-c:v','bmp','-show_packets','-of','json','pipe:0'],{input:bytes,encoding:'utf8',timeout:5000});expect(probe.status,probe.stderr).toBe(0);const result=JSON.parse(probe.stdout) as {packets:{pts:number;dts:number;duration:number;size:string}[]};expect(result.packets.map(p=>[p.pts,p.dts,p.duration,Number(p.size)])).toEqual(packets.map(p=>[Number(p.pts),Number(p.dts),Number(p.duration),p.data.length]));
 }
});
it('stops range reads under consumer backpressure and preserves cancellation and frame budgets',async()=>{
 const data=encodeBmp({width:1,height:1,pixelFormat:'bgr24',planes:[new Uint8Array(3)],linesizes:[3],pts:null,metadata:{}},{maxFrameBytes:100,maxPacketBytes:100}).data,bytes=Buffer.concat([data,data]);let read=0;
 const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){read+=length;return bytes.subarray(Number(offset),Number(offset)+length);}},controller=new AbortController(),options={frameRate:{num:25n,den:1n},maxReadBytes:7,maxPacketBytes:100,maxFrames:1,signal:controller.signal},iterator=openBmpStream(input,options)[Symbol.asyncIterator]();
 await iterator.next();expect(read).toBe(data.length);await expect(iterator.next()).rejects.toThrow('frame budget');
 const pending=openBmpStream(input,{...options,maxFrames:2})[Symbol.asyncIterator]();await pending.next();const before=read;controller.abort();await expect(pending.next()).rejects.toThrow();expect(read).toBe(before);
});
