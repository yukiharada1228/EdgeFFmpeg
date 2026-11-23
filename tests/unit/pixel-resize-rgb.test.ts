import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {resizeVideoFrame,pixelResizeStateBytes,canResizePixelFormat} from '@edge-ffmpeg/swscale';
it('resizes all RGB layouts with padded storage owned output and exact timestamps',()=>{
 for(const format of ['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']){
  const layout=pixelLayout(format,5,3),data=Uint8Array.from({length:layout.bytes},(_,i)=>(i*37+13)&255),source=decodeRawVideo({streamIndex:0,data,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:format,width:5,height:3},{maxFrameBytes:4096}),state=pixelResizeStateBytes(format,5,3,13,7),output=resizeVideoFrame(source,13,7,{maxFrameBytes:4096,maxStateBytes:state});
  const padded={...source,linesizes:layout.planes.map(p=>p.rowBytes+3),planes:source.planes.map((plane,i)=>{const p=layout.planes[i]!,stride=p.rowBytes+3,buffer=new Uint8Array(stride*p.height).fill(99);for(let y=0;y<p.height;y++)buffer.set(plane.subarray(y*p.rowBytes,(y+1)*p.rowBytes),y*stride);return buffer;})};
  expect(canResizePixelFormat(format)).toBe(true);expect(resizeVideoFrame(padded,13,7,{maxFrameBytes:4096,maxStateBytes:state}).planes).toEqual(output.planes);expect(output.pts).toEqual(source.pts);expect(output.pts).not.toBe(source.pts);
  for(const [i,plane]of output.planes.entries()){expect(plane.buffer).toBe(output.planes[0]!.buffer);expect(plane.buffer).not.toBe(source.planes[0]!.buffer);expect(plane.byteOffset).toBe(pixelLayout(format,13,7).planes[i]!.offset);}
  expect(()=>resizeVideoFrame(source,13,7,{maxFrameBytes:4096,maxStateBytes:state-1})).toThrow('state');expect(()=>resizeVideoFrame(source,13,7,{maxFrameBytes:4096,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
  expect(resizeVideoFrame(padded,5,3,{maxFrameBytes:4096,maxStateBytes:0}).planes).toEqual(source.planes);
 }
});
it('accounts for three or four RGB accumulation rows and shares common axes',()=>{
 const gray=pixelResizeStateBytes('gray',5,3,13,7);expect(pixelResizeStateBytes('rgb24',5,3,13,7)).toBe(gray+8*13);expect(pixelResizeStateBytes('gbrp',5,3,13,7)).toBe(gray+8*13);expect(pixelResizeStateBytes('rgba',5,3,13,7)).toBe(gray+12*13);
 expect(pixelResizeStateBytes('rgb24',5,3,5,3)).toBe(0);expect(pixelResizeStateBytes('rgba',6,4,2,2)).toBeGreaterThan(pixelResizeStateBytes('rgb24',6,4,2,2));
});
