import {expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import {compileFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';
import {compileFlacTimePolicy} from '../../packages/avformat/src/flac-wave-time.js';
import {processTimedBufferedFlac} from '../../packages/avformat/src/flac-timed-buffered.js';
import {countFlacAudio} from '../../packages/avformat/src/flac-wave-encode.js';

function setup(description:string,input:readonly string[]=[],output:readonly string[]=[],samples=5,resident=1048576){
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:resident,maxBufferBytes:64,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 const format={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',pts:{value:0n,timeBase:{num:1n,den:8000n}}};
 const bytes=new Uint8Array(samples*2),view=new DataView(bytes.buffer);for(let i=0;i<samples;i++)view.setInt16(i*2,i+1,true);
 let closed=false,pulled=0;
 const source=(async function*(){try{if(samples){pulled++;yield {...format,samples,planes:[bytes]};}}finally{closed=true;}})();
 const command=parseArgv([...input,'-i','/in.flac',...output,'/out.pcm']);
 const stream=processTimedBufferedFlac(source,compileFlacAudioFilters(description,'s16'),compileFlacTimePolicy(command),format,BigInt(samples),{resources,signal,maxFrameBytes:64});
 return {stream,resources,get closed(){return closed;},get pulled(){return pulled;}};
}
async function render(stream:AsyncIterable<AudioFrameData>){const frames:AudioFrameData[]=[];for await(const frame of stream)frames.push({...frame,planes:frame.planes.map(plane=>plane.slice())});return frames;}
const values=(frames:readonly AudioFrameData[])=>frames.flatMap(frame=>{const plane=frame.planes[0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);return Array.from({length:frame.samples},(_,i)=>view.getInt16(i*2,true));});
it('selects an output padding window beyond the original decoded EOF',async()=>{
 const run=setup('apad=pad_len=7',[],['-ss','0.000875','-t','0.000375']);
 expect(values(await render(run.stream))).toEqual([0,0,0]);expect(run.resources.allocatedBytes).toBe(0);
});
it('trims input recording time before padding and output seek after padding',async()=>{
 const run=setup('apad=pad_len=7',['-t','0.00025'],['-ss','0.000125','-t','0.001']);
 expect(values(await render(run.stream))).toEqual([2,0,0,0,0,0,0,0]);expect(run.closed).toBe(true);expect(run.resources.allocatedBytes).toBe(0);
});
it('pads a configured empty source before applying the output time window',async()=>{
 const run=setup('apad=pad_len=7',[],['-ss','0.00025','-t','0.000375'],0);
 expect(values(await render(run.stream))).toEqual([0,0,0]);expect(run.resources.allocatedBytes).toBe(0);
});
it('preserves reframed packet boundaries after trimming and applies frame limit last',async()=>{
 const run=setup('asetnsamples=n=4:p=1',[],['-ss','0.00025','-t','0.000625']);
 const frames=await render(run.stream);expect(frames.map(frame=>frame.samples)).toEqual([2,3]);expect(values(frames)).toEqual([3,4,5,0,0]);
 const limited=setup('asetnsamples=n=4:p=1',[],['-ss','0.00025','-t','0.000625']);
 expect(await countFlacAudio(limited.stream,limited.resources.signal,1n)).toMatchObject({samples:2n,frames:1n});
 await new Promise<void>(resolve=>setTimeout(resolve,0));expect(limited.resources.allocatedBytes).toBe(0);
});
it('does not generate padding or acquire input for a zero output duration',async()=>{
 const run=setup('apad=pad_len=7',[],['-t','0']);
 expect(await render(run.stream)).toEqual([]);expect(run.pulled).toBe(0);expect(run.resources.allocatedBytes).toBe(0);
});
it('unwinds actual simultaneous trim/filter storage on budget failure',async()=>{
 const run=setup('apad=pad_len=32',[],['-t','0.001'],5,64);
 await expect(render(run.stream)).rejects.toThrow(/Memory budget/);expect(run.resources.allocatedBytes).toBe(0);expect(run.closed).toBe(true);
});
it('releases filter and output storage when the consumer returns inside a padding window',async()=>{
 const run=setup('apad=pad_len=7',[],['-ss','0.000875']);
 const iterator=run.stream[Symbol.asyncIterator]();expect((await iterator.next()).done).toBe(false);expect(run.resources.allocatedBytes).toBeGreaterThan(0);
 await iterator.return?.();expect(run.resources.allocatedBytes).toBe(0);expect(run.closed).toBe(true);
});
it.each(['apad=pad_len=7','asetnsamples=n=4:p=0'])('admits finite timed buffering while retaining runtime rate negotiation: %s',description=>{
 const command=parseArgv(['-i','/in.flac','-t','0.001','-af',description,'-ar','8000','/out.pcm']);
 expect(compileFlacTransform(command,{format:'s16le',codec:'pcm_s16le'})?.filters?.reframes).toBe(true);
});
