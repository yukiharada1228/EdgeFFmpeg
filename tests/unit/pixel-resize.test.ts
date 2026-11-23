import {expect,it} from 'vitest';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
const frame=():VideoFrameData=>({width:2,height:2,pixelFormat:'gray',planes:[new Uint8Array([0,85,170,255])],linesizes:[2],pts:{value:9007199254740993n,timeBase:{num:1001n,den:30000n}},metadata:{tag:'source'}});
it('resizes tiny gray frames with owned output and preserved exact timestamp metadata',()=>{
 const source=frame(),output=resizeVideoFrame(source,4,4,{maxFrameBytes:4096,maxStateBytes:4096});
 expect([...output.planes[0]!]).toEqual([0,0,85,85,0,0,85,85,170,170,255,255,170,170,255,255]);expect([output.width,output.height,output.pixelFormat,output.linesizes]).toEqual([4,4,'gray',[4]]);
 expect(output.pts).toEqual(source.pts);expect(output.pts).not.toBe(source.pts);expect(output.metadata).toEqual(source.metadata);expect(output.metadata).not.toBe(source.metadata);expect(output.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);
});
it('handles gray8 padded input and identity geometry without retaining caller storage',()=>{
 const source={...frame(),pixelFormat:'gray8',planes:[new Uint8Array([0,85,99,170,255])],linesizes:[3]},output=resizeVideoFrame(source,2,2,{maxFrameBytes:16,maxStateBytes:0});
 expect([...output.planes[0]!]).toEqual([0,85,170,255]);expect(output.pixelFormat).toBe('gray');expect(output.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);expect(pixelResizeStateBytes('gray',2,2,2,2)).toBe(0);
});
it('preflights arbitrary-ratio state and rejects invalid frames and budgets without support-height row products',()=>{
 const state=pixelResizeStateBytes('gray',2,2,16,9);expect(state).toBeGreaterThan(0);
 expect(()=>resizeVideoFrame(frame(),16,9,{maxFrameBytes:4096,maxStateBytes:state-1})).toThrow('state');expect(resizeVideoFrame(frame(),16,9,{maxFrameBytes:4096,maxStateBytes:state}).planes[0]).toHaveLength(144);
 expect(pixelResizeStateBytes('gray',128,65,1,1)).toBeGreaterThan(256);
 const large=pixelResizeStateBytes('gray',1,2147483647,2147483647,1);expect(Number.isSafeInteger(large)).toBe(true);expect(large).toBeGreaterThan(2147483647);
 expect(()=>resizeVideoFrame(frame(),4,4,{maxFrameBytes:15})).toThrow('frame');
 expect(()=>resizeVideoFrame({...frame(),linesizes:[1]},4,4,{maxFrameBytes:4096})).toThrow('stride');
 expect(()=>resizeVideoFrame({...frame(),planes:[new Uint8Array(4097)]},4,4,{maxFrameBytes:4096})).toThrow('storage');
 expect(()=>resizeVideoFrame({...frame(),pixelFormat:'rgb24'},4,4,{maxFrameBytes:4096})).toThrow('stride');
 expect(()=>resizeVideoFrame({...frame(),pts:{value:0n,timeBase:{num:1n,den:0n}}},4,4,{maxFrameBytes:4096})).toThrow('time base');
});
it('propagates cancellation before allocating resize state or publishing a result',()=>{
 const reason=new Error('stop');expect(()=>resizeVideoFrame(frame(),16,9,{maxFrameBytes:4096,signal:AbortSignal.abort(reason)})).toThrow(reason);
});
it('preflights output-size frame and filter budgets before opening either file',async()=>{
 const state=pixelResizeStateBytes('gray',5,3,13,7),required=4*15+6*91+state+512;let opens=0;
 const filesystem={async openRead(){opens++;throw new Error('unexpected read');},async openWrite(){opens++;throw new Error('unexpected write');}};
 const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:required-1,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
 const result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-video_size','5x3','-i','/in','-s','13x7','-f','framecrc','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
 const unsupported=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(['-f','rawvideo','-pixel_format','yuv420p','-video_size','5x3','-i','/in','-vf','scale=13:7:flags=neighbor','-f','rawvideo','/out']);expect(unsupported.diagnostics[0]?.code).toBe('unsupported-command');expect(opens).toBe(0);
 const invalid=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(['-f','rawvideo','-pixel_format','gray','-video_size','5x3','-i','/in','-s','bad','-f','rawvideo','/out']);expect(invalid.diagnostics[0]?.code).toBe('invalid-arguments');expect(opens).toBe(0);
});
