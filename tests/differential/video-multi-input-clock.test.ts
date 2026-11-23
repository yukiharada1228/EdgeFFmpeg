import {beforeAll,it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {compileMultiInputVideoFilterGraph as compileMultiFrameGraph} from '@edge-ffmpeg/avfilter';import type {Rational,VideoFrameData} from '@edge-ffmpeg/avutil';import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native join clocks independently of each source time base',()=>{
 referencePixelArithmetic();const n=9007199254740993n,cases:[Rational,Rational,bigint,bigint][]=[
 [{num:1n,den:25n},{num:1n,den:50n},1n,2n],
 [{num:1n,den:25n},{num:2n,den:50n},1n,1n],
 [{num:1n,den:1000001n},{num:1n,den:1000001n},1n,1n],
 [{num:1n,den:500000n},{num:1n,den:1000000n},1n,2n],
 [{num:1001n,den:30000n},{num:1n,den:30000n},2n,2002n],
 [{num:1n,den:25n},{num:1n,den:50n},n,n*2n],
 [{num:2n,den:50n},{num:4n,den:100n},1n,1n],
 [{num:4n,den:100n},{num:1n,den:50n},1n,2n]];
 for(const [a,b,ap,bp]of cases){const native=JSON.parse(execFileSync('.build/oracles/frame-sync/native',['0',`${a.num}/${a.den}`,`${b.num}/${b.den}`,String(ap),String(bp)],{encoding:'utf8',timeout:10000})),sources=[{format:'gray',width:1,height:1},{format:'gray',width:1,height:1}],frames:VideoFrameData[]=[{width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(10)],linesizes:[1],pts:{value:ap,timeBase:a},metadata:{}},{width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(100)],linesizes:[1],pts:{value:bp,timeBase:b},metadata:{}}],plan=compileMultiFrameGraph('[a][b]hstack[out]').plan(sources,['gray']),output=plan.applyBatch(frames,{maxFrameBytes:256,maxStateBytes:4096,maxResidentBytes:4096})[0]!;
 expect({accepted:true,timeBase:{num:Number(output.pts!.timeBase.num),den:Number(output.pts!.timeBase.den)},events:[{pts:String(output.pts!.value),values:[...output.planes[0]!]}],eof:true},`${a.num}/${a.den}/${b.num}/${b.den}/${ap}/${bp}`).toEqual(native);
 }
});

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','frame-sync'],{timeout:30000});},30000);
