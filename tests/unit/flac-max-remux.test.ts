import {expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {muxFlac} from '../../packages/containers/src/flac/mux.js';
import type {FlacMuxOptions} from '../../packages/containers/src/flac/mux.js';
import {openFlacDemux} from '../../packages/containers/src/flac/demux.js';
import corpus from '../../compat/behavior-specs/flac-max-remux/cases.json' with {type:'json'};

const budget={maxResidentBytes:1048576,maxBufferBytes:34,maxPendingPackets:8,maxCpuTimeMs:10000};
const row=corpus.rows.find(entry=>entry.id==='16-2-ramp-5/default')!;
const input=Buffer.from(row.input,'base64');
function setup(controller=new AbortController()){
 const resources=new ResourceContext(budget,controller.signal),chunks:Uint8Array[]=[];
 let commits=0,aborts=0;
 const writer:WriteHandle={async write(bytes){expect(bytes.length).toBeLessThanOrEqual(34);chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;}};
 const options:FlacMuxOptions={streamInfo:input.subarray(8,42),metadataPolicy:{mode:'drop'},resources,signal:controller.signal,maxWriteBytes:34,paddingBytes:0,bitexact:true};
 return {resources,chunks,writer,options,get commits(){return commits;},get aborts(){return aborts;}};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

it('writes a final comment block and byte-identical STREAMINFO without pulling zero-limited packets',async()=>{
 const run=setup();let pulled=false;
 await muxFlac(run.writer,{async *[Symbol.asyncIterator](){pulled=true;throw Error('must not pull');}},{...run.options,maxPackets:0n});
 const bytes=Buffer.concat(run.chunks);
 expect(bytes.subarray(0,8)).toEqual(Buffer.from([102,76,97,67,0,0,0,34]));
 expect(bytes.subarray(8,42)).toEqual(input.subarray(8,42));expect(bytes[42]).toBe(0x84);
 expect(bytes.readUIntBE(43,3)).toBe(bytes.length-46);
 expect(bytes.readUInt32LE(46)).toBe(6);expect(bytes.toString('utf8',50,56)).toBe('ffmpeg');expect(bytes.readUInt32LE(56)).toBe(0);
 expect(pulled).toBe(false);expect(run.commits).toBe(1);expect(run.aborts).toBe(0);expect(run.resources.allocatedBytes).toBe(0);
});

for(const limit of [1n,2n])it(`preserves real compressed packet bytes with frame limit ${limit}`,async()=>{
 const run=setup(),demux=await openFlacDemux({size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+Math.min(length,7));}},{resources:run.resources,signal:run.options.signal,maxScanBytes:BigInt(input.length),maxPacketBytes:BigInt(input.length),maxReadBytes:34});
 try{await muxFlac(run.writer,demux.packets,{...run.options,maxPackets:limit});}finally{await demux.close();}
 const bytes=Buffer.concat(run.chunks),audio=46+bytes.readUIntBE(43,3),length=row.inputPackets.slice(0,Number(limit)).reduce((sum,packet)=>sum+packet.bytes,0);
 expect(bytes.subarray(audio)).toEqual(input.subarray(row.inputMetadata.audioOffset,row.inputMetadata.audioOffset+length));
 expect(bytes.subarray(8,42)).toEqual(input.subarray(8,42));expect(run.commits).toBe(1);expect(run.resources.allocatedBytes).toBe(0);
});

for(const invalid of [{maxWriteBytes:0},{paddingBytes:-1},{maxPackets:-1n},{streamInfo:new Uint8Array(33)}])it(`rejects invalid mux boundary ${Object.keys(invalid)[0]}`,async()=>{
 const run=setup();let pulled=false;
 await expect(muxFlac(run.writer,{async *[Symbol.asyncIterator](){pulled=true;}},{...run.options,...invalid})).rejects.toThrow();
 expect(pulled).toBe(false);expect(run.chunks).toEqual([]);expect(run.commits).toBe(0);expect(run.resources.allocatedBytes).toBe(0);
});

it('accounts metadata before output and rejects a real exhausted resident budget',async()=>{
 const run=setup(),resources=new ResourceContext({...budget,maxResidentBytes:34},run.options.signal);
 await expect(muxFlac(run.writer,{async *[Symbol.asyncIterator](){}},{...run.options,resources})).rejects.toThrow(/budget/i);
 expect(run.chunks).toEqual([]);expect(run.commits).toBe(0);expect(resources.allocatedBytes).toBe(0);
});

it('backpressures the first write before requesting compressed packets',async()=>{
 const run=setup(),entered=deferred<void>(),gate=deferred<void>();let pulled=false,writes=0;
 const task=muxFlac({...run.writer,async write(bytes){if(writes++===0){entered.resolve();await gate.promise;}await run.writer.write(bytes);}},{async *[Symbol.asyncIterator](){pulled=true;}},run.options);
 await entered.promise;expect(pulled).toBe(false);expect(run.commits).toBe(0);expect(run.resources.allocatedBytes).toBeGreaterThan(0);
 gate.resolve();await task;expect(pulled).toBe(true);expect(run.resources.allocatedBytes).toBe(0);
});

for(const late of ['resolve','reject'] as const)it(`cancels a stalled write promptly, retaining staging until late ${late}`,async()=>{
 const controller=new AbortController(),run=setup(controller),entered=deferred<void>(),gate=deferred<void>(),reason=Error('cancel mux');
 const task=muxFlac({...run.writer,async write(){entered.resolve();await gate.promise;}},{async *[Symbol.asyncIterator](){}},run.options);
 const checked=expect(task).rejects.toBe(reason);await entered.promise;controller.abort(reason);await checked;
 expect(run.commits).toBe(0);expect(run.resources.allocatedBytes).toBe(34);
 if(late==='resolve')gate.resolve();else gate.reject(Error('late provider failure'));
 await tick();expect(run.resources.allocatedBytes).toBe(0);expect(run.aborts).toBe(1);expect(run.commits).toBe(0);
});

for(const failure of ['write','commit'] as const)it(`aborts ${failure} failure and releases all owned bytes`,async()=>{
 const run=setup(),reason=Error(failure);
 await expect(muxFlac({...run.writer,async write(bytes){if(failure==='write')throw reason;await run.writer.write(bytes);},async commit(){throw reason;}},{async *[Symbol.asyncIterator](){}},run.options)).rejects.toBe(reason);
 expect(run.aborts).toBe(1);expect(run.commits).toBe(0);expect(run.resources.allocatedBytes).toBe(0);
});
