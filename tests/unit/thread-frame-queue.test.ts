import {it,expect} from 'vitest';import {createThreadFrameQueue} from '@edge-ffmpeg/avutil';
it('wakes a blocked sender on receive finish and keeps rejected leases with the caller',async()=>{
 const q=createThreadFrameQueue<number>(2,{maxFrames:1,maxBytes:1}),released:number[]=[],lease=(value:number)=>({value,bytes:1,release(){released.push(value);}}),first=lease(1),second=lease(2);expect(q.trySend(0,first)).toBe(0);const pending=q.send(1,second);q.receiveFinish(1);expect(await pending).toBe(-541478725);expect(released).toEqual([]);expect(q.trySend(1,second)).toBe(-22);const read=q.tryReceive();expect(read.stream).toBe(0);read.lease?.release();q.dispose();expect(released).toEqual([1]);second.release();expect(released).toEqual([1,2]);
});
it('returns FIFO order across streams and unchokes a blocked receiver on send finish',async()=>{
 const q=createThreadFrameQueue<number>(2,{maxFrames:2,maxBytes:2});q.choke(true);q.trySend(1,{value:11,bytes:1,release(){}});q.trySend(0,{value:22,bytes:1,release(){}});const pending=q.receive();q.sendFinish(1);const first=await pending;expect(first).toMatchObject({code:0,stream:1,lease:{value:11}});first.lease?.release();const second=await q.receive();expect(second.stream).toBe(0);second.lease?.release();expect(await q.receive()).toMatchObject({code:-541478725,stream:1});q.sendFinish(0);expect(await q.receive()).toMatchObject({code:-541478725,stream:0});expect(await q.receive()).toMatchObject({code:-541478725,stream:-1});q.dispose();
});
it('cancels blocked admission without accepting or releasing the caller frame',async()=>{
 const q=createThreadFrameQueue<number>(1,{maxFrames:1,maxBytes:1}),controller=new AbortController(),reason=new Error('cancel admission'),released:number[]=[];q.trySend(0,{value:1,bytes:1,release(){released.push(1);}});const second={value:2,bytes:1,release(){released.push(2);}},before=q.snapshot(),pending=q.send(0,second,controller.signal),rejected=expect(pending).rejects.toBe(reason);controller.abort(reason);await rejected;expect(q.snapshot()).toEqual(before);expect(released).toEqual([]);q.dispose();expect(released).toEqual([1]);second.release();expect(released).toEqual([1,2]);
});
it('rejects oversized frames without parking and bounds pending waiters',async()=>{
 const q=createThreadFrameQueue<number>(1,{maxFrames:1,maxBytes:1,maxWaiters:1}),controller=new AbortController(),reason=new Error('cancel receiver');await expect(q.send(0,{value:1,bytes:2,release(){}})).rejects.toThrow('exceeds byte');const pending=q.receive(controller.signal),rejected=expect(pending).rejects.toBe(reason);await expect(q.receive()).rejects.toThrow('waiter budget');controller.abort(reason);await rejected;q.dispose();
});
it('retains a discard failure, releases the rest and wakes pending receivers on disposal',async()=>{
 const q=createThreadFrameQueue<number>(2,{maxFrames:2,maxBytes:2}),failure=new Error('discard'),released:number[]=[];q.trySend(0,{value:0,bytes:1,release(){released.push(0);throw failure;}});q.trySend(1,{value:1,bytes:1,release(){released.push(1);}});q.receiveFinish(0);expect(()=>q.tryReceive()).toThrow(failure);expect(()=>q.tryReceive()).toThrow(failure);let disposal:AggregateError|undefined;try{q.dispose();}catch(error){expect(error).toBeInstanceOf(AggregateError);disposal=error as AggregateError;}expect(disposal!.errors).toEqual([failure]);expect(released).toEqual([0,1]);expect(q.snapshot().bytes).toBe(0);expect(()=>q.dispose()).toThrow(disposal);
 const pendingQueue=createThreadFrameQueue<number>(1,{maxFrames:1,maxBytes:1}),pending=pendingQueue.receive(),rejected=expect(pending).rejects.toThrow('disposed');pendingQueue.dispose();await rejected;
});
it('snapshots accepted byte counts and release callbacks and preserves receiver ownership after disposal',()=>{
 const options={maxFrames:2,maxBytes:2},q=createThreadFrameQueue<number>(1,options);let released=0;
 const lease={value:7,bytes:1,release(){released++;}};
 expect(q.trySend(0,lease)).toBe(0);lease.bytes=99;lease.release=()=>{throw new Error('Replaced release must not be used');};options.maxBytes=0;
 expect(q.snapshot().bytes).toBe(1);const received=q.tryReceive();expect(q.snapshot().bytes).toBe(0);expect(received.lease).toMatchObject({value:7,bytes:1});q.dispose();expect(released).toBe(0);received.lease!.release();expect(released).toBe(1);
});
