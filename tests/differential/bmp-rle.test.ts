import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {decodeBmp} from '@edge-ffmpeg/avcodec';
import {image} from '../helpers/bmp-fixture.js';
function compare(data:Uint8Array,label:string){
 const frame=decodeBmp({streamIndex:0,data,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{maxFrameBytes:1048576,maxPacketBytes:1048576}),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt','pal8','-f','rawvideo','pipe:1'],{input:data,timeout:5000});
 expect(native.status,label+String(native.stderr)).toBe(0);expect(Buffer.concat(frame.planes.map(p=>Buffer.from(p))),label).toEqual(native.stdout);
}
it('matches native RLE4/RLE8 runs, absolute literals, odd padding, deltas and top-down storage',()=>{
 let jobs=0;
 for(const depth of [4,8])for(const top of [false,true])for(const width of [3,5,9,17])for(const mode of ['runs','absolute','delta']){
  const stream:number[]=[];
  for(let row=0;row<3;row++){
   if(mode==='runs'){stream.push(width,depth===8?row*33+17:0x12+row);}
   else if(mode==='delta'){stream.push(0,2,1,0,width-1,depth===8?row*21+27:0x34+row);}
   else {stream.push(0,width);const packed=depth===8?width:Math.ceil(width/2);for(let i=0;i<packed;i++)stream.push((i*31+row*7+53)%256);if(packed%2)stream.push(0);}
   stream.push(0,0);
  }
  stream.push(0,1);compare(image(width,3,depth,top,stream),String([depth,top,width,mode]));jobs++;
 }
 expect(jobs).toBe(48);
});
it('matches native early end, skipped blank rows and bounded truncated partial frames',()=>{
 for(const depth of [4,8])for(const top of [false,true])for(const stream of [[0,1],[2,0x12,0,1],[0,2,1,1,2,0x45,0,1],[2,0x23],[0,4,0x12]])compare(image(7,4,depth,top,stream),String([depth,top,stream]));
});
