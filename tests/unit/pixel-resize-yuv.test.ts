import {expect,it} from 'vitest';
import {canResizePixelFormat,resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
const formats=['yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'];
function input(format:string){const layout=pixelLayout(format,5,3);return decodeRawVideo({streamIndex:0,data:Uint8Array.from({length:layout.bytes},(_,i)=>(i*37+13)&255),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:format,width:5,height:3},{maxFrameBytes:4096});}
it('resizes padded planar semiplanar and alpha frames into disjoint owned tight output views',()=>{
 for(const format of formats){
  expect(canResizePixelFormat(format)).toBe(true);const source=input(format),layout=pixelLayout(format,5,3),state=pixelResizeStateBytes(format,5,3,13,7),output=resizeVideoFrame(source,13,7,{maxFrameBytes:4096,maxStateBytes:state});
  const padded={...source,linesizes:source.linesizes.map(x=>x+3),planes:source.planes.map((plane,i)=>{const p=layout.planes[i]!,stride=p.rowBytes+3,data=new Uint8Array(stride*p.height).fill(99);for(let row=0;row<p.height;row++)data.set(plane.subarray(row*p.rowBytes,(row+1)*p.rowBytes),row*stride);return data;})};
  expect(resizeVideoFrame(padded,13,7,{maxFrameBytes:4096,maxStateBytes:state}).planes.map(x=>[...x])).toEqual(output.planes.map(x=>[...x]));
  const expected=pixelLayout(format,13,7);expect(output.linesizes).toEqual(expected.planes.map(p=>p.rowBytes));expect(output.planes.map(p=>p.length)).toEqual(expected.planes.map(p=>p.bytes));expect(output.pts).toEqual(source.pts);
  for(const [i,plane]of output.planes.entries()){expect(plane.buffer).toBe(output.planes[0]!.buffer);expect(plane.buffer).not.toBe(source.planes[0]!.buffer);expect(plane.byteOffset).toBe(expected.planes[i]!.offset);}
  expect(()=>resizeVideoFrame(source,13,7,{maxFrameBytes:4096,maxStateBytes:state-1})).toThrow('state');
 }
 expect(canResizePixelFormat('rgb24')).toBe(true);expect(canResizePixelFormat('unknown')).toBe(false);
});
it('shares identical axes across color planes alpha and semiplanar components',()=>{
 const gray=pixelResizeStateBytes('gray',5,3,13,7),planar=pixelResizeStateBytes('yuv420p',5,3,13,7);
 expect(pixelResizeStateBytes('yuv444p',5,3,13,7)).toBe(gray);expect(planar).toBeGreaterThan(gray);
 for(const format of ['yuva420p','nv12','nv21'])expect(pixelResizeStateBytes(format,5,3,13,7)).toBe(planar);
});
it('preserves constant alpha and UV order and bounds aggregate padded source storage',()=>{
 for(const format of ['yuva420p','nv12','nv21']){
  const source=input(format);
  if(format==='yuva420p')source.planes[3]!.fill(200);else for(let i=0;i<source.planes[1]!.length;i++)source.planes[1]![i]=i%2===0?11:233;
  const output=resizeVideoFrame(source,13,7,{maxFrameBytes:4096});
  if(format==='yuva420p')expect([...output.planes[3]!]).toEqual(Array(91).fill(200));else expect([...output.planes[1]!]).toEqual(Array.from({length:56},(_,i)=>i%2===0?11:233));
 }
 const source=input('yuv420p'),large={...source,planes:source.planes.map(p=>new Uint8Array(p.length+100))};
 expect(()=>resizeVideoFrame(large,5,3,{maxFrameBytes:100,maxStateBytes:0})).toThrow('storage');
 expect(()=>resizeVideoFrame({...source,linesizes:[5,2,3]},13,7,{maxFrameBytes:4096})).toThrow('stride');
 const stop=new Error('stop');expect(()=>resizeVideoFrame(source,13,7,{maxFrameBytes:4096,signal:AbortSignal.abort(stop)})).toThrow(stop);
});
