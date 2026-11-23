import {expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {countFlacAudio,encodeFlacAudio} from '../../packages/avformat/src/flac-wave-encode.js';

function setup(limit:bigint|null=1n,resident=64){
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:resident,maxBufferBytes:16,maxCpuTimeMs:1000,maxPendingPackets:1},signal);
 let pulls=0,closed=0;
 const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:2,planes:[new Uint8Array([1,0,255,127])],pts:{value:17n,timeBase:{num:1n,den:8000n}}};
 const source=(async function*(){try{for(let i=0;i<2;i++){pulls++;const release=resources.reserveExternalMemory(4);try{yield frame;}finally{release();}}}finally{closed++;}})();
 const output=encodeFlacAudio(source,'pcm_s32le',{resources,signal,maxFrameBytes:16,frameLimit:limit})[Symbol.asyncIterator]();
 return {resources,output,get pulls(){return pulls;},get closed(){return closed;}};
}
it('accounts conversion and packet storage across yield, preserves PTS and closes at the encoded frame limit',async()=>{
 const run=setup();const item=await run.output.next();
 expect(item.done).toBe(false);expect(item.value).toMatchObject({pts:17n,duration:2n});
 expect(Array.from(item.value!.data)).toEqual([0,0,1,0,0,0,255,127]);
 expect(run.resources.allocatedBytes).toBe(20);expect(run.pulls).toBe(1);
 expect((await run.output.next()).done).toBe(true);expect(run.pulls).toBe(1);expect(run.closed).toBe(1);expect(run.resources.allocatedBytes).toBe(0);
});
it('does not acquire the decoder stream for a zero frame limit',async()=>{
 const run=setup(0n);expect((await run.output.next()).done).toBe(true);expect(run.pulls).toBe(0);expect(run.resources.allocatedBytes).toBe(0);
});
it('closes input and releases reservations when real simultaneous encoding storage exceeds budget',async()=>{
 const run=setup(1n,19);await expect(run.output.next()).rejects.toThrow(/Memory budget/);expect(run.closed).toBe(1);expect(run.resources.allocatedBytes).toBe(0);
});
it('releases borrowed packet and source on consumer return',async()=>{
 const run=setup(null);await run.output.next();await run.output.return?.();expect(run.closed).toBe(1);expect(run.resources.allocatedBytes).toBe(0);
});
it('counts actual transformed frame lengths and closes the prepass at its frame limit',async()=>{
 let closed=false,pulls=0;
 const source=(async function*(){try{for(const samples of [3,5,7]){pulls++;yield {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples,planes:[new Uint8Array(samples*2)],pts:null};}}finally{closed=true;}})();
 const result=await countFlacAudio(source,new AbortController().signal,2n);
 expect(result).toEqual({samples:8n,frames:2n,audio:{sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16'}});
 expect(pulls).toBe(2);expect(closed).toBe(true);
});
