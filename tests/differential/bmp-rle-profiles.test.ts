import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {decodeBmp} from '@edge-ffmpeg/avcodec';
import {image} from '../helpers/bmp-fixture.js';
import {readBmpRleProfiles,verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('matches1536 cached Native RLE partial frames under explicit row capacity profiles',()=>{
 const rows=readBmpRleProfiles();
 expect(rows).toHaveLength(1536);
 for(const row of rows){let state=row.seed;const stream:number[]=[];for(let i=0;i<31;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;stream.push(state>>>24);}stream.push(0,1);
  const data=image(row.width,4,row.depth,row.top,stream),frame=decodeBmp({streamIndex:0,data,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{maxFrameBytes:1048576,maxPacketBytes:1048576,rleLineAlignment:row.alignment}),bytes=Buffer.concat(frame.planes.map(p=>Buffer.from(p)));
  expect(row.stride).toBe(Math.ceil(row.width/row.alignment)*row.alignment);expect(createHash('sha256').update(bytes).digest('hex'),JSON.stringify(row)).toBe(row.sha256);
 }
});
