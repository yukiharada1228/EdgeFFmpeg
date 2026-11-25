import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {decodeBmp} from '@edge-ffmpeg/avcodec';
import {image} from '../helpers/bmp-fixture.js';
import {referenceRleLineAlignment,verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
// Native's default row capacity is a property of the pinned reference build (STRIDE_ALIGN), so Edge runs that profile.
const rleLineAlignment=referenceRleLineAlignment();
it('matches native bounded malformed RLE partial-frame pixels',()=>{
 const failures:unknown[]=[];
 for(const depth of [4,8])for(const top of [false,true])for(const width of [3,17,33])for(let seed=1;seed<=32;seed++){
  let state=seed;const stream:number[]=[];for(let i=0;i<31;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;stream.push(state>>>24);}stream.push(0,1);
  const data=image(width,4,depth,top,stream),frame=decodeBmp({streamIndex:0,data,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{maxFrameBytes:1048576,maxPacketBytes:1048576,rleLineAlignment}),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt','pal8','-f','rawvideo','pipe:1'],{input:data,timeout:5000});
  if(native.status!==0||!Buffer.concat(frame.planes.map(p=>Buffer.from(p))).equals(native.stdout))if(failures.length<8)failures.push({depth,top,width,seed,stream,actual:Array.from(frame.planes[0]!),expected:Array.from(native.stdout.subarray(0,width*4)),stderr:String(native.stderr)});
 }
 expect(failures).toEqual([]);
});
