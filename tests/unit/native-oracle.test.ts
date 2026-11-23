import {it,expect} from 'vitest';
import {createNativeOracle,runBoundedCases} from '../helpers/native-oracle.js';
it('covers every lazy Native oracle case once with at most two active cases',async({signal})=>{
 let active=0,peak=0;const seen=new Set<number>();
 const count=await runBoundedCases(Array.from({length:100},(_,i)=>i),2,signal,async value=>{active++;peak=Math.max(peak,active);await Promise.resolve();expect(seen.has(value)).toBe(false);seen.add(value);active--;});
 expect(count).toBe(100);expect(seen.size).toBe(100);expect(peak).toBe(2);expect(active).toBe(0);
});
it('preserves the first comparison error and awaits cancellation of its peer',async({signal})=>{
 const reason=new Error('comparison mismatch');let peerClosed=false;
 await expect(runBoundedCases([0,1,2,3],2,signal,async(value,caseSignal)=>{if(value===1)throw reason;try{await new Promise<void>((_resolve,reject)=>{caseSignal.addEventListener('abort',()=>reject(caseSignal.reason),{once:true});});}finally{peerClosed=true;}})).rejects.toBe(reason);expect(peerClosed).toBe(true);
});
it('waits for both real Native oracle child processes to close after cancellation',async({signal})=>{
 const controller=new AbortController(),reason=new Error('cancel oracle'),oracle=createNativeOracle();
 const pending=runBoundedCases([0,1],2,AbortSignal.any([signal,controller.signal]),async(value,caseSignal)=>{const result=oracle.run(process.execPath,['-e','setTimeout(()=>{},60000)'],caseSignal);if(value===1)setTimeout(()=>controller.abort(reason),20);await result;});
 await expect(pending).rejects.toBe(reason);expect(oracle.metrics).toEqual({calls:2,active:0,peak:2,failures:2});
});
it('preserves Native oracle binary stdout and nonzero exit errors',async({signal})=>{
 const oracle=createNativeOracle();expect(await oracle.run(process.execPath,['-e','process.stdout.write(Buffer.from([0,255,17]))'],signal)).toEqual(Buffer.from([0,255,17]));
 await expect(oracle.run(process.execPath,['-e','process.exit(17)'],signal)).rejects.toMatchObject({code:17});expect(oracle.metrics).toEqual({calls:2,active:0,peak:1,failures:1});
});
