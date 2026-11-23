import {it,expect} from 'vitest';
import {convertVideoFrame,resizeVideoFrame} from '@edge-ffmpeg/swscale';
import {pixelLayout} from '@edge-ffmpeg/avutil';
it('refuses unsupported color metadata without returning misleading limited-range RGB',()=>{
 const layout=pixelLayout('yuv420p',16,4),data=Uint8Array.from({length:layout.bytes},(_,i)=>(i*71)&255);
 for(const metadata of [{colorSpace:10},{colorSpace:12},{colorSpace:1.5},{colorSpace:NaN},{colorSpace:'bt709'},{colorSpace:1,colorRange:3},{colorSpace:1,colorRange:'pc'}]){
  const frame={width:16,height:4,pixelFormat:'yuv420p',planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata};
  expect(()=>convertVideoFrame(frame,'rgb24',{maxFrameBytes:4096,maxStateBytes:4096})).toThrow(RangeError);
  expect(()=>resizeVideoFrame(frame,13,7,{maxFrameBytes:4096,maxStateBytes:4096,outputPixelFormat:'rgb24'})).toThrow(RangeError);
 }
});
