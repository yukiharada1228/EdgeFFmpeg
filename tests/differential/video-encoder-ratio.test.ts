import {beforeAll,it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {parseEncoderTimeBase} from '../../packages/avformat/src/video-output/encoder-ratio.js';
it('matches pinned av_parse_ratio decimal, scientific, colon and division conversion',()=>{
 const samples=['0','0/25','1/25','2:50','1:1000','0.04','4e-2','0.001001','1e-300','-1e-300','1e-9','1e-10','1e9','1e10','-0.04','1/0','0/0','1:-25','-1:-25','2147483647:1','1:2147483647','2147483647/2147483646','0.03336666666666667','100000000000/1000000000000','1e3/25000',' 0.04 ','0.00000000023283064365386963'];let seed=8147;
 for(let i=0;i<512;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const numerator=(seed%2000000000)+1;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const denominator=(seed%2000000000)+1;samples.push(i%3===0?`${numerator}/${denominator}`:i%3===1?`${numerator}:${denominator}`:`${numerator}e-${i%18}`);}
 for(const value of samples){const native=JSON.parse(execFileSync('.build/oracles/encoder-ratio/native',[value],{encoding:'utf8',timeout:5000}));let actual:ReturnType<typeof parseEncoderTimeBase>,accepted=true;try{actual=parseEncoderTimeBase(value);}catch{accepted=false;}expect(accepted,value).toBe(native.accepted);if(accepted){expect(typeof actual,value).not.toBe('string');const ratio=actual??{num:0n,den:1n};expect(ratio,value).toEqual({num:BigInt(native.num),den:BigInt(native.den)});}}
 expect(samples).toHaveLength(539);
},30000);

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','encoder-ratio'],{timeout:30000});},30000);
