import {beforeAll,it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {parseEncoderTimeBase} from '../../packages/avformat/src/video-output/encoder-ratio.js';import {evaluateClockExpression} from '../../packages/avformat/src/video-output/clock-expression.js';
it('matches native ratio expressions with arithmetic, precedence, signs, constants and hex literals',()=>{
 const samples=['1/(25*2)','1/(25+5)','1/(25-5)','2^3^2','-2^2','(-2)^2','2^-2','1*-2','1++2','1--2','1+-2','1/PI','1/E','1/PHI','1/QP2LAMBDA','0x10/0X100','1/inf','nan','1/(1/(-0))','((1+2)*3)/1000','2^0.5','3^0.3'];
 for(let i=1;i<=192;i++)samples.push(`1/(${i}+25*2)`,`(${i}+1)^2/(2^8)`,`1/(${i}*PI+E)`);
 for(const value of samples){const native=JSON.parse(execFileSync('.build/oracles/encoder-ratio/native',[value],{encoding:'utf8',timeout:5000}));let actual:ReturnType<typeof parseEncoderTimeBase>,accepted=true;try{actual=parseEncoderTimeBase(value);}catch{accepted=false;}expect(accepted,value).toBe(native.accepted);if(accepted){expect(typeof actual,value).not.toBe('string');expect(actual??{num:0n,den:1n},value).toEqual({num:BigInt(native.num),den:BigInt(native.den)});}}
 expect(samples).toHaveLength(598);
},30000);
it('enforces explicit expression depth and operation bounds',()=>{
 expect(()=>evaluateClockExpression('('.repeat(33)+'1'+')'.repeat(33))).toThrow(/nesting/);expect(()=>evaluateClockExpression(Array.from({length:100},()=>1).join('+'))).toThrow(/operation/);expect(()=>evaluateClockExpression('1'.repeat(257))).toThrow(/length/);expect(()=>evaluateClockExpression('sqrt(2)')).toThrow(/Unsupported/);
});

beforeAll(()=>{execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','encoder-ratio'],{timeout:30000});},30000);
