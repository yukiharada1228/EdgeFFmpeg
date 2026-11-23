import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {decodeBmp,encodeRawVideo} from '@edge-ffmpeg/avcodec';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('connects native BMP images to the existing raw video codec across packed and paletted layouts',()=>{
 for(const format of ['bgr24','bgra','rgb555le','rgb565le','rgb444le','gray','pal8','monob','rgb8','bgr8','rgb4_byte','bgr4_byte'])for(const width of [1,7]){
  const layout=pixelLayout(format,width,3),input=Uint8Array.from({length:layout.bytes},(_,i)=>(i*29+13)%256),bmp=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x3`,'-i','pipe:0','-frames:v','1','-c:v','bmp','-f','image2pipe','pipe:1'],{input,timeout:5000});expect(bmp.status,String(bmp.stderr)).toBe(0);
  const frame=decodeBmp({streamIndex:0,data:new Uint8Array(bmp.stdout),pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1},{maxFrameBytes:8192,maxPacketBytes:8192}),raw=encodeRawVideo(frame,{num:25n,den:1n},{maxFrameBytes:8192}),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt',frame.pixelFormat,'-f','rawvideo','pipe:1'],{input:bmp.stdout,timeout:5000});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.from(raw.data),String([format,width])).toEqual(native.stdout);
 }
});
