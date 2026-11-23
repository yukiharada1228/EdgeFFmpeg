import {expect,it} from 'vitest';
import {compileExpression,evaluateExpression} from '@edge-ffmpeg/avutil';
const options={numericProfile:'linux-x64' as const};
it('keeps compiled state isolated and evaluates only selected branches',()=>{
 const prints:number[]=[];
 const evaluate=compileExpression('if(N,print(st(0,ld(0)+N)),ld(0))',{...options,constants:['N'],onPrint:entry=>prints.push(entry.value)});
 expect(prints).toEqual([]);
 expect(evaluate([2])).toBe(2);expect(evaluate([0])).toBe(2);expect(evaluate([3])).toBe(5);
 expect(prints).toEqual([2,5]);
 expect(evaluateExpression('ld(0)',options)).toBe(0);
 expect(evaluateExpression('if(1,7,while(1,1))',options)).toBe(7);
});
it('snapshots names and binds reused value arrays separately for each invocation',()=>{
 const names=['N'];const evaluate=compileExpression('N+1',{...options,constants:names});
 names[0]='OTHER';const values=new Float64Array([2]);expect(evaluate(values)).toBe(3);
 values[0]=8;expect(evaluate(values)).toBe(9);
 const lazy=compileExpression('if(1,2,N)',{...options,constants:['N']});
 expect(lazy({length:1,get 0():number{throw new Error('unused');}})).toBe(2);
});
it('recovers bindings and reentrancy guard after a callback throws',()=>{
 let fail=true;let reenter=()=>0;
 const evaluate=compileExpression('print(N)',{...options,constants:['N'],onPrint:()=>{
  expect(()=>reenter()).toThrow(/already running/);if(fail)throw new Error('callback failed');
 }});reenter=()=>evaluate([99]);
 expect(()=>evaluate([3])).toThrow('callback failed');fail=false;expect(evaluate([8])).toBe(8);
});
it('bounds evaluation per call and preserves the next usable invocation',()=>{
 const evaluate=compileExpression('if(N,while(1,1),4)',{...options,constants:['N']});
 expect(()=>evaluate([1])).toThrow(/execution budget/);expect(evaluate([0])).toBe(4);
 expect(()=>compileExpression('('.repeat(33)+'1'+')'.repeat(33),options)).toThrow(/nesting/);
 expect(()=>compileExpression('1'.repeat(257),options)).toThrow(/length/);
});
it('injects time and delivers formatted print effects',()=>{
 const entries:unknown[]=[];
 expect(evaluateExpression('print(time(0),24)',{...options,nowMicroseconds:()=>1234567n,onPrint:entry=>entries.push(entry)})).toBe(1.234567);
 expect(entries).toEqual([{value:1.234567,level:24,text:'1.234567\n'}]);
});
it('requires a deliberate profile and models native power identities',()=>{
 expect(()=>compileExpression('1',{numericProfile:'unknown' as 'linux-x64'})).toThrow(/explicit/i);
 expect(evaluateExpression('1^NaN',options)).toBe(1);
 expect(evaluateExpression('(-1)^inf',options)).toBe(1);
});
