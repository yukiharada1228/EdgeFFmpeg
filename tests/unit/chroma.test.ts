import {expect,it} from 'vitest';
import {convertVideoFrame,pixelConversionStateBytes} from '@edge-ffmpeg/swscale';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
function input(){return decodeRawVideo({streamIndex:0,data:new Uint8Array([...Array(15).fill(128),...[0,255,0,255,0,0,255,0,255,0,0,255,0,255,0],...[255,0,255,0,255,255,0,255,0,255,255,0,255,0,255]]),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:'yuv444p',width:5,height:3},{maxFrameBytes:1024});}
it('matches fixed native odd-border bicubic chroma anchors with owned planes and exact timestamps',()=>{
 const source=input(),output=convertVideoFrame(source,'yuv420p',{maxFrameBytes:1024,maxStateBytes:1024});expect(output.planes.map(plane=>[...plane])).toEqual([Array(15).fill(128),[111,119,100,111,119,100],[144,136,155,144,136,155]]);expect(output.pts).toEqual(source.pts);expect(output.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);expect(output.linesizes).toEqual([5,3,3]);
 const padded={...source,planes:source.planes.map(plane=>{const bytes=new Uint8Array(21).fill(99);for(let row=0;row<3;row++)bytes.set(plane.subarray(row*5,row*5+5),row*7);return bytes;}),linesizes:[7,7,7]};expect(convertVideoFrame(padded,'nv21',{maxFrameBytes:1024,maxStateBytes:1024}).planes[1]).toEqual(new Uint8Array([144,111,136,119,155,100,144,111,136,119,155,100]));
});
it('reproduces even-width RGB pairing and native alpha quantization while odd widths retain full input chroma',()=>{
 for(const width of [2,3]){
  const row=[255,0,0,128,0,0,255,255,0,255,0,127].slice(0,width*4),bytes=new Uint8Array([...row,...row,...row]),source=decodeRawVideo({streamIndex:0,data:bytes,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{width,height:3,pixelFormat:'rgba'},{maxFrameBytes:1024}),output=convertVideoFrame(source,'yuva420p',{maxFrameBytes:1024,maxStateBytes:1024});
  expect(output.planes.map(plane=>[...plane])).toEqual(width===2?[[81,41,81,41,81,41],[165,165],[175,175],[129,255,129,255,129,255]]:[[81,41,145,81,41,145,81,41,145],[90,54,90,54],[240,34,240,34],[129,255,127,129,255,127,129,255,127]]);
 }
});
it('rejects insufficient filter storage and cancellation before returning converted pixels',()=>{
 const source=input(),bytes=pixelConversionStateBytes('yuv444p','yuv420p',5,3);expect(bytes).toBeGreaterThan(0);expect(()=>convertVideoFrame(source,'yuv420p',{maxFrameBytes:1024,maxStateBytes:bytes-1})).toThrow('state');expect(()=>convertVideoFrame(source,'yuv420p',{maxFrameBytes:1024,maxStateBytes:1024,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');expect(convertVideoFrame(source,'yuv420p',{maxFrameBytes:1024,maxStateBytes:bytes}).planes[1]).toHaveLength(6);
});
it('includes filter and row storage in CLI preflight before input or output opens',async()=>{
 const state=pixelConversionStateBytes('rgb24','yuv420p',3,3),payload=4*27+6*17;let opens=0;
 const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('unexpected');},async openWrite(){opens++;return collectingOutput().output;}},backend:createMediaBackend(),budget:{maxResidentBytes:payload+state-1,maxBufferBytes:64,maxCpuTimeMs:1000,maxPendingPackets:2}});
 const result=await frontend.exec(['-f','rawvideo','-s','3x3','-pix_fmt','rgb24','-i','/in','-pix_fmt','yuv420p','-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
});
