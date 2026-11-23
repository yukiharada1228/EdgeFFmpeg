import {expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {compileFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';
import {processFlacFilterRate} from '../../packages/avformat/src/flac-filter-rate.js';
import {resampleFlacAudio} from '../../packages/avformat/src/flac-wave-resample.js';

it.each([
 ['aformat=sample_fmts=flt','flt',0,'s16','flt'],
 ['aformat=sample_fmts=s16p','s16',1,'s16p','s16'],
 ['aformat=sample_fmts=fltp,volume=0.5','s16',2,'flt','s16'],
 ['volume=0.5,aformat=sample_fmts=s16','s16',1,'flt','s16']
] as const)('negotiates the automatic resampler around %s', (description,target,beforeStep,inputFormat,outputFormat)=>{
 const chain=compileFlacAudioFilters(description,target);
 expect(chain.rateBoundary('s16',8000,11025)).toEqual({beforeStep,inputRate:8000,outputRate:11025,inputFormat,outputFormat});
});
function setup(resident=1048576){
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:resident,maxBufferBytes:512,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 let closed=false;
 const data=new Uint8Array(192),view=new DataView(data.buffer);
 for(let i=0;i<96;i++)view.setInt16(i*2,i*13-600,true);
 const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:96,planes:[data],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
 const source=(async function*(){try{yield frame;}finally{closed=true;}})();
 const chain=compileFlacAudioFilters('aformat=sample_fmts=flt','flt');
 const stream=processFlacFilterRate(source,chain,'s16',8000,11025,{resources,signal,maxFrameBytes:512,inputFormat:{...frame}});
 return {stream,resources,get closed(){return closed;}};
}
it('holds both filter and FIR reservations while yielding and releases them at EOF',async()=>{
 const run=setup();let samples=0;
 for await(const frame of run.stream){
  expect(frame.sampleRate).toBe(11025);expect(frame.sampleFormat).toBe('flt');
  expect(frame.planes[0]!.byteLength).toBeLessThanOrEqual(512);expect(run.resources.allocatedBytes).toBeGreaterThan(512);
  samples+=frame.samples;
 }
 expect(samples).toBe(133);expect(run.resources.allocatedBytes).toBe(0);expect(run.closed).toBe(true);
});
it('unwinds filter reservation when the inserted FIR cannot fit its real budget',async()=>{
 const run=setup(512);
 await expect(run.stream[Symbol.asyncIterator]().next()).rejects.toThrow(/allocation limit|Memory budget/);
 expect(run.resources.allocatedBytes).toBe(0);expect(run.closed).toBe(true);
});
it('places boundary-zero input recording time after FIR rather than truncating its history',async()=>{
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:1048576,maxBufferBytes:512,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 const data=new Uint8Array(192);
 const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:96,planes:[data],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
 const source=(async function*(){yield frame;})();
 const chain=compileFlacAudioFilters('aformat=sample_fmts=flt','flt');
 let samples=0;
 for await(const output of processFlacFilterRate(source,chain,'s16',8000,16000,{resources,signal,maxFrameBytes:512,inputFormat:frame},{startSample:0n,endSampleExclusive:48n,outputPtsSamples:0n}))samples+=output.samples;
 // Native's pre-trim converter supplies 48 output samples at 16kHz for 3ms.
 // Trimming the 8kHz source first would retain 24 samples and drain only 40.
 expect(samples).toBe(48);
 // FIR return observes pending upstream cleanup before releasing its lease.
 await new Promise<void>(resolve=>setTimeout(resolve,0));
 expect(resources.allocatedBytes).toBe(0);
});
it('bounds an inserted FIR chunk for a wider downstream conversion without shrinking allowed source frames',async()=>{
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:1048576,maxBufferBytes:512,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:256,planes:[new Uint8Array(512)],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
 const source=(async function*(){yield frame;})();
 const chain=compileFlacAudioFilters('aformat=sample_fmts=s16p,aformat=sample_fmts=dbl','dbl');
 let samples=0,frames=0;
 for await(const output of processFlacFilterRate(source,chain,'s16',8000,16000,{resources,signal,maxFrameBytes:512,inputFormat:frame})){
  expect(output.sampleFormat).toBe('dbl');expect(output.planes[0]!.length).toBeLessThanOrEqual(512);samples+=output.samples;frames++;
 }
 expect(samples).toBe(512);expect(frames).toBeGreaterThan(1);expect(resources.allocatedBytes).toBe(0);
});

it.each([0,9,1.5,Number.NaN])('rejects invalid downstream width before source acquisition: %s',maxBytesPerSample=>{
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:1048576,maxBufferBytes:512,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 let acquired=false;
 const source:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){acquired=true;throw new Error('Unexpected source acquisition');}};
 expect(()=>resampleFlacAudio(source,16000,'flt',{resources,signal,maxFrameBytes:512,maxBytesPerSample})).toThrow(/downstream resampling sample width/);
 expect(acquired).toBe(false);expect(resources.allocatedBytes).toBe(0);
});

it('retains double intermediate negotiation when the final encoder is integer',()=>{
 const command=parseArgv(['-cpuflags','0','-i','/in.flac','-t','0.002','-af','aformat=sample_fmts=dbl','-ar','48000','/out.au']);
 const plan=compileFlacTransform(command,{format:'au',codec:'pcm_s16be'})!;
 expect(plan.filters?.rateBoundary('s32',8000,48000)).toEqual({beforeStep:1,inputRate:8000,outputRate:48000,inputFormat:'dbl',outputFormat:'s16'});
 expect(plan.scalar).toBe(true);
});
