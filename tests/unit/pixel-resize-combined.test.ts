import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {resizeVideoFrame,pixelResizeStateBytes,convertVideoFrame,pixelConversionStateBytes,canResizePixelFormat} from '@edge-ffmpeg/swscale';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
const frame=(format:string,width=5,height=3)=>decodeRawVideo({streamIndex:0,data:Uint8Array.from({length:pixelLayout(format,width,height).bytes},(_,i)=>(i*37+13)&255),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:4096});
it('preserves owned fused outputs timestamps and padded component layouts within exact state budgets',()=>{
 for(const [source,destination]of [['nv21','yuv444p'],['yuv444p','yuva420p'],['rgba','nv12'],['gbrp','gray'],['gray','rgba'],['rgba','gbrp'],['rgb24','abgr']]){
  const input=frame(source!),state=pixelResizeStateBytes(source!,5,3,13,7,destination!),layout=pixelLayout(source!,5,3),padded={...input,linesizes:layout.planes.map(p=>p.rowBytes+3),planes:input.planes.map((plane,i)=>{const p=layout.planes[i]!,stride=p.rowBytes+3,data=new Uint8Array(stride*p.height).fill(99);for(let y=0;y<p.height;y++)data.set(plane.subarray(y*p.rowBytes,(y+1)*p.rowBytes),y*stride);return data;})},options={maxFrameBytes:4096,maxStateBytes:state,outputPixelFormat:destination!},output=resizeVideoFrame(input,13,7,options);
  expect(resizeVideoFrame(padded,13,7,options).planes).toEqual(output.planes);expect(output.pixelFormat).toBe(destination);expect(output.pts).toEqual(input.pts);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);expect(()=>resizeVideoFrame(input,13,7,{...options,maxStateBytes:state-1})).toThrow('state');expect(()=>resizeVideoFrame(input,13,7,{...options,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
 }
});
it('retains the established unscaled conversion path including fast BGR and explicit scalar inverse profiles',()=>{
 for(const [source,destination,arithmetic]of [['bgr24','yuv420p','aarch64'],['nv12','rgba','scalar']] as const){
  const input=frame(source,16,6),state=pixelResizeStateBytes(source,16,6,16,6,destination,arithmetic),options={outputPixelFormat:destination,maxFrameBytes:4096,maxStateBytes:state,arithmetic};expect(state).toBe(pixelConversionStateBytes(source,destination,16,6,arithmetic));expect(resizeVideoFrame(input,16,6,options)).toEqual(convertVideoFrame(input,destination,options));
 }
 expect(canResizePixelFormat('nv12','rgba')).toBe(true);expect(canResizePixelFormat('rgba','nv12')).toBe(true);expect(pixelResizeStateBytes('nv12',5,3,13,7,'rgba')).toBeGreaterThan(0);
 expect(()=>compileVideoFilterChain('scale=13:7').plan('gray',5,3).apply(frame('gray'),{outputPixelFormat:'rgba',maxFrameBytes:4096})).toThrow('format');
});
it('rejects fused output expansion budgets before I/O',async()=>{
 const {FFmpeg}=await import('@edge-ffmpeg/core'),{createMediaBackend}=await import('@edge-ffmpeg/avformat');let opens=0;
 const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected read');},async openWrite(){opens++;throw new Error('Unexpected write');}},backend:createMediaBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:10000}});
 const expanded=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in','-s','13x7','-pix_fmt','rgba','-f','rawvideo','/out']);expect(expanded.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
});
