import {expect,it,vi} from 'vitest';
import type {FlacDecodedFrame,FlacDecoder,FlacDecoderMetadata,FlacDecoderResult} from '@edge-ffmpeg/avcodec';
import {countFlacSamples} from '../../packages/avformat/src/flac-prepass.js';
const info:FlacDecoderMetadata={channels:2,sampleRate:48000,bitsPerSample:16,totalSamples:0n,maxBlockSamples:256};
const signal=()=>new AbortController().signal;
function frame(overrides:Partial<FlacDecodedFrame>={}):FlacDecodedFrame{return {status:'frame',metadata:info,samples:256,samplePosition:0n,get planes():readonly Int32Array[]{throw Error('Counting must not access PCM');},release:vi.fn(),...overrides};}
function decoder(items:FlacDecoderResult[]):FlacDecoder{return {metadata:info,bytesRead:0n,memoryBytes:16777216,next:vi.fn(async()=>{const item=items.shift();if(!item)throw Error('Unexpected extra next');return item;}),close:vi.fn(async()=>{})};}
it.each([0n,1n,2n,99n,null])('counts exactly the requested prefix %s without reading PCM or closing its caller-owned decoder',async limit=>{
 const a=frame(),b=frame({samples:1,samplePosition:256n}),d=decoder([{status:'metadata',metadata:info},a,b,{status:'end',metadata:info}]);
 expect(await countFlacSamples(d,info,limit,signal())).toBe(limit===0n?0n:limit===1n?256n:257n);
 expect(a.release).toHaveBeenCalledTimes(limit===0n?0:1);expect(b.release).toHaveBeenCalledTimes(limit===0n||limit===1n?0:1);expect(d.close).not.toHaveBeenCalled();
 expect(d.next).toHaveBeenCalledTimes(limit===0n?0:limit===1n?2:limit===2n?3:4);
});
it.each([-1n,1n<<63n,1,NaN,undefined])('rejects invalid public frame limit %s before reading',async value=>{
 const d=decoder([]);await expect(countFlacSamples(d,info,value as bigint,signal())).rejects.toMatchObject({code:'invalid-arguments'});expect(d.next).not.toHaveBeenCalled();
});
const invalidMetadata:Partial<FlacDecoderMetadata>[]=[{channels:0},{channels:9},{channels:1.5},{sampleRate:0},{sampleRate:655351},{sampleRate:NaN},{bitsPerSample:3},{bitsPerSample:33},{bitsPerSample:4.5},{totalSamples:-1n},{totalSamples:1n<<63n},{totalSamples:1 as unknown as bigint},{maxBlockSamples:0},{maxBlockSamples:65536},{maxBlockSamples:1.5}];
it.each(invalidMetadata)('rejects invalid initial metadata %s even for a zero prefix',async invalid=>{
 const d=decoder([]);await expect(countFlacSamples(d,{...info,...invalid},0n,signal())).rejects.toMatchObject({code:'invalid-arguments'});expect(d.next).not.toHaveBeenCalled();
});
it.each(invalidMetadata)('releases a frame with invalid metadata %s',async invalid=>{
 const item=frame({metadata:{...info,...invalid}});await expect(countFlacSamples(decoder([item]),info,1n,signal())).rejects.toMatchObject({code:'invalid-arguments'});expect(item.release).toHaveBeenCalledOnce();
});
it.each([{samples:0},{samples:-1},{samples:257},{samples:1.5},{samples:NaN},{samples:Infinity},{samplePosition:-1n},{samplePosition:1n<<63n},{samplePosition:1 as unknown as bigint}])('releases invalid frame metadata %s',async invalid=>{
 const item=frame(invalid);await expect(countFlacSamples(decoder([item]),info,1n,signal())).rejects.toMatchObject({code:'invalid-arguments'});expect(item.release).toHaveBeenCalledOnce();
});
it.each([{channels:1},{sampleRate:44100},{bitsPerSample:24},{totalSamples:1000n},{maxBlockSamples:512}])('rejects changed metadata on frames, metadata and end %s',async changed=>{
 for(const status of ['frame','metadata','end'] as const){const item=frame({metadata:{...info,...changed}}),result=status==='frame'?item:{status,metadata:item.metadata};await expect(countFlacSamples(decoder([result]),info,null,signal())).rejects.toMatchObject({code:'unsupported-command'});expect(item.release).toHaveBeenCalledTimes(status==='frame'?1:0);}
});
it('releases a noncontiguous frame and a frame exceeding the declared total',async()=>{
 for(const item of [frame({samplePosition:1n}),frame({metadata:{...info,totalSamples:1n}})]){await expect(countFlacSamples(decoder([item]),item.metadata,null,signal())).rejects.toThrow();expect(item.release).toHaveBeenCalledOnce();}
});
it('rejects a declared total mismatch only when the selected prefix reaches EOF',async()=>{
 const known={...info,totalSamples:257n},item=frame({metadata:known}),end={status:'end' as const,metadata:known};
 expect(await countFlacSamples(decoder([item]),known,1n,signal())).toBe(256n);
 await expect(countFlacSamples(decoder([frame({metadata:known}),end]),known,99n,signal())).rejects.toThrow('sample count mismatch');
 expect(await countFlacSamples(decoder([{status:'end',metadata:info}]),info,null,signal())).toBe(0n);
});
it.each(['resolve','reject'] as const)('detaches cancellation and observes late decoder %s',async action=>{
 let resolve!:(item:FlacDecoderResult)=>void,reject!:(reason:unknown)=>void;
 const pending=new Promise<FlacDecoderResult>((r,j)=>{resolve=r;reject=j;}),d=decoder([]),abort=new AbortController(),reason=Error('cancel prepass');d.next=vi.fn(()=>pending);
 const count=countFlacSamples(d,info,null,abort.signal);abort.abort(reason);await expect(count).rejects.toBe(reason);
 const item=frame();if(action==='resolve')resolve(item);else reject(Error('late decoder failure'));
 await Promise.resolve();expect(item.release).toHaveBeenCalledTimes(action==='resolve'?1:0);expect(d.close).not.toHaveBeenCalled();
});
it('releases an already delivered frame when cancelled before the await resumes',async()=>{
 const abort=new AbortController(),item=frame(),d=decoder([]),reason=Error('cancel delivered frame');d.next=()=>{queueMicrotask(()=>abort.abort(reason));return Promise.resolve(item);};
 await expect(countFlacSamples(d,info,1n,abort.signal)).rejects.toBe(reason);expect(item.release).toHaveBeenCalledOnce();
});
it('rejects pre-aborted calls without pulling and preserves synchronous provider failures',async()=>{
 const abort=new AbortController(),reason=Error('already cancelled'),d=decoder([]);abort.abort(reason);
 await expect(countFlacSamples(d,info,0n,abort.signal)).rejects.toBe(reason);expect(d.next).not.toHaveBeenCalled();
 d.next=()=>{throw reason;};await expect(countFlacSamples(d,info,null,signal())).rejects.toBe(reason);
});
it('snapshots the initial metadata across awaits',async()=>{
 const mutable={...info},item=frame(),d=decoder([]);d.next=()=>{mutable.channels=1;return Promise.resolve(item);};
 expect(await countFlacSamples(d,mutable,1n,signal())).toBe(256n);expect(item.release).toHaveBeenCalledOnce();
});
