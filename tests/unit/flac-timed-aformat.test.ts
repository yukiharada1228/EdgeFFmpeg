import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import {processFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';

const output={format:'s16le',codec:'pcm_s16le'} as const;
const compile=(description:string,extra:readonly string[]=[])=>compileFlacTransform(parseArgv(['-cpuflags','0','-i','/in.flac','-ss','0.001','-t','0.002','-af',description,...extra,'/out.pcm']),output)!;
it.each(['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'])('admits timed singleton aformat conversion: %s',format=>{
 const plan=compile('aformat=sample_fmts='+format);
 expect(plan.timed).toBe(true);expect(plan.filters?.resolvedSampleFormat('s16')).toBe(format);expect(plan.scalar).toBe(true);
});
it.each(['aformat=s16','aformat=f=s16'])('retains supported singleton syntax: %s',description=>{
 expect(compile(description).filters?.resolvedSampleFormat('s32')).toBe('s16');
});
it('retains sample-local volume negotiation around timed aformat and scalar rounding',()=>{
 const plan=compile('aformat=sample_fmts=fltp,volume=0.5,aformat=sample_fmts=s16');
 expect(plan.filters?.steps.map(step=>step.name)).toEqual(['aformat','volume','aformat']);
 expect(plan.filters?.resolvedSampleFormat('s32')).toBe('s16');expect(plan.filters?.requiresScalarRounding('s32')).toBe(true);
});
it.each(['asetrate=8000'])('retains timed scheduling rejection for aformat plus %s',stage=>{
 expect(()=>compile('aformat=sample_fmts=s16,'+stage)).toThrow(/Native packet scheduling/);
});
it.each(['aformat=sample_fmts=s16|flt', 'aformat=sample_rates=8000|16000','aformat=channel_layouts=mono|stereo'])('retains unsupported negotiation constraints: %s',description=>{
 expect(()=>compile(description)).toThrow(/one supported/);
});
it('does not invent a configured sample format for bare timed aformat',()=>{
 expect(()=>compile('aformat')).toThrow(/Native packet scheduling/);
});
it('accounts planar conversion before allocation and releases its reservation on return',async()=>{
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:64,maxBufferBytes:64,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 const compiled=compile('aformat=sample_fmts=s16p').filters!;
 const frame:AudioFrameData={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:2,planes:[new Uint8Array([1,0,2,0,3,0,4,0])],pts:{value:0n,timeBase:{num:1n,den:8000n}}};
 let closed=false;
 const source=(async function*(){try{yield frame;}finally{closed=true;}})();
 const iterator=processFlacAudioFilters(source,compiled,{resources,signal,maxFrameBytes:64})[Symbol.asyncIterator]();
 const item=await iterator.next();
 if(item.done)throw new Error('Expected converted frame');
 const converted=item.value as AudioFrameData;
 expect(converted.planes.map(plane=>Array.from(plane))).toEqual([[1,0,3,0],[2,0,4,0]]);
 expect(converted.sampleRate).toBe(8000);expect(converted.samples).toBe(2);expect(resources.allocatedBytes).toBe(64);
 await iterator.return?.();expect(resources.allocatedBytes).toBe(0);expect(closed).toBe(true);
});
it('rejects the actual simultaneous aformat stage budget before advancing source',async()=>{
 const signal=new AbortController().signal;
 const resources=new ResourceContext({maxResidentBytes:127,maxBufferBytes:64,maxPendingPackets:1,maxCpuTimeMs:1000},signal);
 let acquired=false;
 const source:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){acquired=true;throw new Error('Source should remain unopened');}};
 const inputFormat={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null};
 const iterator=processFlacAudioFilters(source,compile('aformat=sample_fmts=fltp,aformat=sample_fmts=s16').filters!,{resources,signal,maxFrameBytes:64,inputFormat})[Symbol.asyncIterator]();
 await expect(iterator.next()).rejects.toThrow(/Memory budget/);expect(acquired).toBe(false);expect(resources.allocatedBytes).toBe(0);
});
