import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('matches native raw packet extents for BMP packed and palette layouts including odd widths',()=>{
 let jobs=0;
 for(const format of ['rgb555le','rgb565le','rgb444le','rgb0','bgr0','0rgb','0bgr','rgb8','bgr8','rgb4_byte','bgr4_byte','pal8','monob'])for(const width of [1,3,7,8,9,17])for(const height of [1,3]){
  const layout=pixelLayout(format,width,height),input=new Uint8Array(layout.bytes);for(let i=0;i<input.length;i++)input[i]=(i*13+27)%256;
  const native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-i','pipe:0','-frames:v','1','-c:v','copy','-f','rawvideo','pipe:1'],{input,timeout:5000});
  expect(native.status,String([format,width,height])+String(native.stderr)).toBe(0);expect(Buffer.from(input)).toEqual(native.stdout);expect(layout.planes.reduce((n,p)=>n+p.bytes,0)).toBe(layout.bytes);jobs++;
 }
 expect(jobs).toBe(156);
});
