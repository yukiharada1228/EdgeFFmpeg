import {expect,it} from 'vitest';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';

const format={sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',pts:null};
const frame:AudioFrameData={...format,samples:2,planes:[new Uint8Array([1,0,2,0,3,0,4,0])]};
const options={maxFrameBytes:64,inputFormat:format};
async function collect(frames:AsyncIterable<AudioFrameData>){const result:AudioFrameData[]=[];for await(const frame of frames)result.push(frame);return result;}
it.each(['sample_rates=8000','r=8000','channel_layouts=stereo','cl=stereo','sample_fmts=s16:r=8000:cl=stereo'])('accepts matching singleton aformat constraints: %s',description=>{
 const chain=compileAudioFilterChain('aformat='+description);
 expect(()=>chain.validateInputFormat(format)).not.toThrow();
 expect(chain.apply(frame,{maxFrameBytes:64})).toMatchObject({sampleRate:8000,channels:2,channelLayout:'stereo'});
});
it.each(['r=0','r=-1','r=8000|16000','r=8000.5','r=2147483648','cl=mono|stereo','cl=unknown','sample_rates=','channel_layouts=','sample_fmts=s16|flt'])('rejects malformed or unsupported singleton constraint: %s',description=>{
 expect(()=>compileAudioFilterChain('aformat='+description)).toThrow(/aformat/);
});
it.each(['r=16000','cl=mono'])('rejects a mismatching configured input before source acquisition: %s',description=>{
 let acquired=false;
 const source:AsyncIterable<AudioFrameData>={[Symbol.asyncIterator](){acquired=true;throw new Error('Unexpected source acquisition');}};
 expect(()=>compileAudioFilterChain('volume=0.5,aformat='+description).process(source,options)).toThrow(/implicit conversion/);
 expect(acquired).toBe(false);
});
it('validates actual unconfigured input before earlier scalar conversions allocate',async()=>{
 const chain=compileAudioFilterChain('volume=0.5,aformat=r=16000');
 const source=(async function*(){yield frame;})();
 // A one-byte budget would fail volume conversion first without whole-chain validation.
 await expect(collect(chain.process(source,{maxFrameBytes:1}))).rejects.toThrow(/sample rate constraint/);
});
it('simulates asetrate at each constraint stage without inventing implicit rate changes',()=>{
 expect(()=>compileAudioFilterChain('aformat=r=8000,asetrate=16000,aformat=r=16000').validateInputFormat(format)).not.toThrow();
 expect(()=>compileAudioFilterChain('asetrate=16000,aformat=r=8000').validateInputFormat(format)).toThrow(/sample rate constraint/);
});
it('validates the configured resampler insertion at its actual constraint stage',()=>{
 const chain=compileAudioFilterChain('aformat=sample_fmts=flt:r=8000');
 const insertion={beforeStep:0,transform:(source:AsyncIterable<AudioFrameData>)=>source,outputFormat:{...format,sampleRate:16000}};
 expect(()=>chain.validateInputFormat(format,insertion)).toThrow(/sample rate constraint/);
 expect(()=>chain.validateInputFormat(format,{...insertion,beforeStep:1})).not.toThrow();
});
it('validates constrained configured empty streams and rejects unconfigured emptiness',async()=>{
 const empty=()=> (async function*(){})();
 const chain=compileAudioFilterChain('aformat=r=8000:cl=stereo');
 expect(await collect(chain.process(empty(),options))).toEqual([]);
 await expect(collect(chain.process(empty(),{maxFrameBytes:64}))).rejects.toThrow(/configured empty input format/);
});
it('checks actual frames even when their format changes after configured preflight',async()=>{
 const chain=compileAudioFilterChain('aformat=r=8000:cl=stereo');
 const source=(async function*(){yield {...frame,sampleRate:16000};})();
 await expect(collect(chain.process(source,options))).rejects.toThrow(/sample rate constraint/);
});
it('admits timed identity-only constraints while retaining the bare aformat gap',()=>{
 const compile=(description:string)=>compileFlacTransform(parseArgv(['-i','/in.flac','-t','0.001','-af',description,'/out.pcm']),{format:'s16le',codec:'pcm_s16le'});
 expect(compile('aformat=r=8000:cl=stereo')?.timed).toBe(true);
 expect(()=>compile('aformat')).toThrow(/Native packet scheduling/);
});
it('requires channel count to agree with the declared canonical constraint',()=>{
 const chain=compileAudioFilterChain('aformat=cl=stereo');
 expect(()=>chain.validateInputFormat({...format,channels:1})).toThrow(/channel layout constraint/);
});
