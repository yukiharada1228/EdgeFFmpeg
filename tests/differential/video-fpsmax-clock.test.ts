import {beforeAll,it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import type {Rational} from '@edge-ffmpeg/avutil';import {rawVideoOutputClock} from '../../packages/avformat/src/video-output/output-clock.js';
it('matches native maximum-rate clock selection including floating comparison ties',()=>{
 const rates:Rational[]=[{num:25n,den:1n},{num:30n,den:1n},{num:30000n,den:1001n},{num:1n,den:0n},{num:2147483646n,den:2147483645n}],maxima:Rational[]=[{num:20n,den:1n},{num:25n,den:1n},{num:30n,den:1n},{num:60n,den:1n},{num:30000n,den:1001n},{num:2147483647n,den:2147483646n}],bases:Rational[]=[{num:1n,den:150n},{num:1n,den:30000n},{num:2n,den:50n}],encoders:(Rational|undefined)[]=[undefined,{num:1n,den:1000n},{num:1n,den:50n}],arg=(q:Rational|undefined)=>q?`${q.num}/${q.den}`:'0/0';let checked=0;
 for(const mode of ['cfr','vscfr'] as const)for(const sinkFrameRate of rates)for(const outputMaxFrameRate of maxima)for(const filterTimeBase of bases)for(const encoderTimeBase of encoders){const args=[mode,arg(sinkFrameRate),arg(filterTimeBase),'0/0',arg(encoderTimeBase),'1/1000',arg(outputMaxFrameRate)],native=JSON.parse(execFileSync('.build/oracles/video-output-clock/clock-oracle',args,{encoding:'utf8',timeout:5000})),actual=rawVideoOutputClock({mode,sinkFrameRate,filterTimeBase,outputMaxFrameRate,...(encoderTimeBase?{encoderTimeBase}:{})}),numeric=(q:Rational)=>({num:Number(q.num),den:Number(q.den)});expect({ret:0,frameRate:numeric(actual.frameRate),timeBase:numeric(actual.timeBase)},args.join(' ')).toEqual(native);expect(actual.fallback).toBe(false);checked++;}
 expect(checked).toBe(540);
},30000);
it('rejects output-rate and non-CFR conflicts independently of input presence',()=>{
 const shared={sinkFrameRate:{num:25n,den:1n},filterTimeBase:{num:1n,den:25n},outputMaxFrameRate:{num:20n,den:1n}};
 expect(()=>rawVideoOutputClock({...shared,mode:'vfr'})).toThrow(/contradicts/);expect(()=>rawVideoOutputClock({...shared,mode:'cfr',outputFrameRate:{num:25n,den:1n}})).toThrow(/combine/);
});

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/video-output/build-clock-oracle.mjs'],{timeout:30000});},30000);
