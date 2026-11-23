import { expect,it } from 'vitest';
import { reframeAudio,compileAudioFilterChain } from '@edge-ffmpeg/avfilter';
import type { AudioFrameData } from '@edge-ffmpeg/avutil';
function frame(data:number[],pts:bigint|null):AudioFrameData{return {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'u8',samples:data.length,planes:[new Uint8Array(data)],pts:pts===null?null:{value:pts,timeBase:{num:1n,den:8000n}}};}
async function* source(...frames:AudioFrameData[]){yield* frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const output=[];for await(const frame of frames)output.push(frame);return output;}
it('reframes arbitrary input chunks with bigint PTS and owned outputs including unsigned silence',async()=>{
  const base=9007199254740993n,input=[frame([1],base),frame([2,3,4,5],base+1n)];
  const output=await collect(reframeAudio(source(...input),3,true,{maxFrameBytes:16}));
  expect(output.map(frame=>[frame.samples,frame.pts?.value,[...frame.planes[0]!]])).toEqual([[3,base,[1,2,3]],[3,base+3n,[4,5,128]]]);
  expect(output[0]!.planes[0]!.buffer).not.toBe(output[1]!.planes[0]!.buffer);expect([...input[1]!.planes[0]!]).toEqual([2,3,4,5]);
  const tail=await collect(reframeAudio(source(...input),3,false,{maxFrameBytes:16}));expect(tail[1]!.samples).toBe(2);expect([...tail[1]!.planes[0]!]).toEqual([4,5]);
  expect(await collect(reframeAudio(source(),3,true,{maxFrameBytes:16}))).toEqual([]);
  const unknown=await collect(reframeAudio(source(frame([1],null)),3,true,{maxFrameBytes:16}));expect(unknown[0]!.pts).toBeNull();
});
it('does not read ahead while yielded output is paused and closes upstream on early return',async()=>{
  let produced=0,closed=false;
  async function* frames(){try{for(let i=0;i<8;i++){produced++;yield frame([i],BigInt(i));}}finally{closed=true;}}
  const iterator=reframeAudio(frames(),2,true,{maxFrameBytes:8})[Symbol.asyncIterator]();const first=await iterator.next();expect(produced).toBe(2);expect([...first.value!.planes[0]!]).toEqual([0,1]);
  const second=await iterator.next();expect(produced).toBe(4);expect([...first.value!.planes[0]!]).toEqual([0,1]);expect([...second.value!.planes[0]!]).toEqual([2,3]);await iterator.return?.();expect(closed).toBe(true);expect(produced).toBe(4);
});
it('rejects excess allocation discontinuity invalid frames and cancellation',async()=>{
  await expect(collect(reframeAudio(source(frame([1],0n)),32,true,{maxFrameBytes:16}))).rejects.toThrow('allocation');
  await expect(collect(reframeAudio(source(frame([1],0n),frame([2],2n)),3,true,{maxFrameBytes:16}))).rejects.toThrow('contiguous');
  await expect(collect(reframeAudio(source({...frame([1],0n),samples:2}),3,true,{maxFrameBytes:16}))).rejects.toThrow('Invalid');
  const controller=new AbortController();controller.abort('stop');await expect(collect(reframeAudio(source(frame([1],0n)),3,true,{maxFrameBytes:16,signal:controller.signal}))).rejects.toBe('stop');
});
it('isolates stream state per execution and plans padding and downstream packet sizes',async()=>{
  const chain=compileAudioFilterChain('asetnsamples=n=3:pad=true,volume=0.5:precision=fixed,asetnsamples=nb_out_samples=4:p=1,asetrate=11025',{outputSampleFormat:'u8'});
  expect(chain.reframes).toBe(true);expect(chain.maxBufferedSamples).toBe(4);expect(chain.outputSamples(5n)).toBe(8n);expect(chain.outputPacketSamples(4096n)).toBe(4n);expect(()=>chain.apply(frame([1],0n),{maxFrameBytes:16})).toThrow('stream processing');
  const run=()=>collect(chain.process(source(frame([0,128],0n),frame([255,128,128],2n)),{maxFrameBytes:16}));const [a,b]=await Promise.all([run(),run()]);expect(a.map(frame=>[frame.sampleRate,frame.samples,[...frame.planes[0]!]])).toEqual(b.map(frame=>[frame.sampleRate,frame.samples,[...frame.planes[0]!] ]));expect(a[0]!.planes[0]!.buffer).not.toBe(b[0]!.planes[0]!.buffer);
  for(const value of ['asetnsamples=0','asetnsamples=n=2=3','asetnsamples=1.5','asetnsamples=2:p=nope'])expect(()=>compileAudioFilterChain(value)).toThrow();
});
