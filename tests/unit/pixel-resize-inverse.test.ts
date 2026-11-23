import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {pixelResizeStateBytes,resizeVideoFrame} from '@edge-ffmpeg/swscale';
it('resizes padded YUV inverse planes with owned output exact timestamps and profile-specific state bounds',()=>{
 for(const [source,target,width,height]of [['yuv420p','rgb24',13,7],['yuva420p','bgra',4,3],['nv12','gbrp',13,7]] as const)for(const arithmetic of ['aarch64','scalar','x86_64'] as const){
  const layout=pixelLayout(source,5,3),input=decodeRawVideo({streamIndex:0,data:Uint8Array.from({length:layout.bytes},(_,i)=>(i*37+13)&255),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096}),state=pixelResizeStateBytes(source,5,3,width,height,target,arithmetic),options={outputPixelFormat:target,arithmetic,maxFrameBytes:4096,maxStateBytes:state},output=resizeVideoFrame(input,width,height,options),padded={...input,linesizes:layout.planes.map(p=>p.rowBytes+3),planes:input.planes.map((plane,i)=>{const p=layout.planes[i]!,stride=p.rowBytes+3,data=new Uint8Array(stride*p.height).fill(99);for(let y=0;y<p.height;y++)data.set(plane.subarray(y*p.rowBytes,(y+1)*p.rowBytes),y*stride);return data;})};
  expect(resizeVideoFrame(padded,width,height,options).planes).toEqual(output.planes);expect(output.pts).toEqual(input.pts);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);expect(()=>resizeVideoFrame(input,width,height,{...options,maxStateBytes:state-1})).toThrow('state');expect(()=>resizeVideoFrame(input,width,height,{...options,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
 }
});
it('shares luma alpha axes and reserves every inverse output row without changing unscaled guards',()=>{
 expect(pixelResizeStateBytes('yuva420p',5,3,4,3,'bgra')-pixelResizeStateBytes('nv12',5,3,4,3,'bgra')).toBe(16);expect(pixelResizeStateBytes('yuv444p',5,3,13,7,'rgb24')).toBe(pixelResizeStateBytes('rgb24',5,3,13,7));
 expect(()=>pixelResizeStateBytes('nv12',16,6,16,6,'rgb24')).toThrow('nondeterministic');expect(pixelResizeStateBytes('nv12',16,6,16,12,'rgb24')).toBeGreaterThan(0);
});
