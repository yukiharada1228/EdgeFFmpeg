import {describe,it,expect} from 'vitest';
import {ResourceContext} from '../../packages/core/src/resources.js';
describe('external resident reservations',()=>{
 const budget={maxResidentBytes:20_000_000,maxBufferBytes:1024,maxCpuTimeMs:100,maxPendingPackets:1};
 it('reserves without the buffer limit and shares resident accounting',()=>{
  const context=new ResourceContext(budget,new AbortController().signal);
  const release=context.reserveExternalMemory(16_777_216);
  expect(context.allocatedBytes).toBe(16_777_216);
  const buffer=context.allocate(1024);
  expect(()=>context.reserveExternalMemory(4_000_000)).toThrow('Memory budget');
  expect(()=>context.allocate(1025)).toThrow('Memory budget');
  release();release();expect(context.allocatedBytes).toBe(1024);
  buffer.release();expect(context.allocatedBytes).toBe(0);
 });
 it('rejects invalid sizes and cancellation without changing accounting',()=>{
  const abort=new AbortController(),context=new ResourceContext(budget,abort.signal);
  for(const value of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>context.reserveExternalMemory(value)).toThrow();
  expect(context.allocatedBytes).toBe(0);abort.abort(new Error('cancel'));
  expect(()=>context.reserveExternalMemory(1)).toThrow('cancel');
 });
});
