import {it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {synchronizeFrames} from '@edge-ffmpeg/avfilter';
it('matches Native backward and repeated PTS across distinct input time bases',async()=>{
 execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','frame-sync']);
 const points=[[],[0n],[3n,2n,1n],[0n,2n,1n,3n],[2n,-1n,4n],[0n,0n,-1n],[4n,1n,4n,1n],[0n,1n,2n]],base={num:1n,den:25n},differences=[];
 let checked=0;for(const ab of [base,{num:1n,den:30n},{num:1001n,den:30000n}])for(const bb of [base,{num:1n,den:30n},{num:1001n,den:30000n}])for(const a of points)for(const b of points)for(const shortest of [false,true]){
 const native=JSON.parse(execFileSync('.build/oracles/frame-sync/native',[shortest?'1':'0',`${ab.num}/${ab.den}`,`${bb.num}/${bb.den}`,a.join(','),b.join(',')],{encoding:'utf8',timeout:3000}));
 expect(native.accepted).toBe(true);expect(native.eof).toBe(true);
 const source=(positions:bigint[],offset:number,timeBase:typeof base)=>({timeBase,frames:{async *[Symbol.asyncIterator](){for(const [index,value]of positions.entries())yield {pts:{value,timeBase},value:offset+index};}}});
 const events=[];for await(const event of synchronizeFrames([source(a,10,ab),source(b,100,bb)],{shortest,maxPendingFrames:4,maxResidentBytes:4,timestamp:f=>f.pts,retain(value){return {value,bytes:1,release(){}};}}))events.push({pts:String(event.pts.value),values:event.frames.map(f=>f.value)});
 if(JSON.stringify(events)!==JSON.stringify(native.events))differences.push({ab:String(ab.den),bb:String(bb.den),a:a.map(String),b:b.map(String),shortest,native,events});
 checked++;}
 expect(checked).toBe(1152);expect(differences).toEqual([]);
},30000);
