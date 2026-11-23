import {beforeAll,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {synchronizeFrames,synchronizationTimeBase} from '@edge-ffmpeg/avfilter';
import type {Rational,Timestamp} from '@edge-ffmpeg/avutil';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native all-input framesync event times repetition shortest and empty streams',async()=>{
 referencePixelArithmetic();const bases=[{num:1n,den:25n},{num:1n,den:30n},{num:1001n,den:30000n},{num:1n,den:1000000n},{num:1n,den:500000n},{num:2n,den:25n},{num:2n,den:50n},{num:4n,den:100n}],points=[[],[0n],[0n,2n,4n],[1n,3n],[-2n,0n,2n],[0n,0n,1n],[5n,9n,13n]];let count=0;
 interface Frame{pts:Timestamp;value:number}
 for(const a of bases)for(const b of bases)for(const ap of points)for(const bp of points)for(const shortest of [false,true]){
  const native=JSON.parse(execFileSync('.build/oracles/frame-sync/native',[shortest?'1':'0',`${a.num}/${a.den}`,`${b.num}/${b.den}`,ap.join(','),bp.join(',')],{encoding:'utf8',timeout:10000}));
  const make=(timeBase:Rational,positions:bigint[],offset:number)=>({timeBase,frames:{async *[Symbol.asyncIterator](){for(const [index,value]of positions.entries())yield {pts:{value,timeBase},value:offset+index};}}});
  const events=[];for await(const event of synchronizeFrames([make(a,ap,10),make(b,bp,100)],{shortest,maxPendingFrames:4,maxResidentBytes:4,timestamp:(frame:Frame)=>frame.pts,retain(frame:Frame,available:number){if(available<1)throw new Error('Lease budget');return {value:frame,bytes:1,release(){}};}}))events.push({pts:String(event.pts.value),values:event.frames.map(x=>x.value)});
  const target=synchronizationTimeBase([a,b]);expect({accepted:true,timeBase:{num:Number(target.num),den:Number(target.den)},events,eof:true},`${a.num}/${a.den}/${b.num}/${b.den}/${ap}/${bp}/${shortest}`).toEqual(native);count++;
 }
 expect(count).toBe(6272);
},120000);

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','frame-sync'],{timeout:30000});},30000);
