import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';
import {resolveFlacTimePolicy} from '../../packages/avformat/src/flac-wave-time.js';
import {countResampledFlacSamples} from '../../packages/avformat/src/flac-wave-resample.js';

const output={format:'s16le',codec:'pcm_s16le'} as const;
function compile(input:readonly string[],target:readonly string[]){
 return compileFlacTransform(parseArgv(['-cpuflags','0',...input,'-i','/in.flac',...target,'/out.pcm']),output)!;
}
it.each(['-ar','-ar:a','-ar:a:0'])('admits timed FLAC output rate through %s without changing arithmetic selection',alias=>{
 const plan=compile(['-t','0.003'],['-ss','0.001','-to','0.004',alias,'16000']);
 expect(plan.rate).toBe(16000);expect(plan.scalar).toBe(true);expect(plan.time.input.duration).toBe(3000n);
 expect(plan.time.output).toEqual({seek:1000n,duration:3000n,stop:4000n});
});
it.each(['anull','volume=0.5','anull,volume=0.5,volume=2'])('admits only independently sample-local filters with timed rate: %s',description=>{
 expect(compile([],['-ss','0.001','-t','0.002','-ar','44100','-af',description]).filters?.steps.map(step=>step.name)).toEqual(description.split(',').map(step=>step.split('=')[0]));
});
it.each(['asetrate=16000'])('retains explicit timed-rate scheduling gap for %s',description=>{
 expect(()=>compile([],['-t','0.001','-ar','16000','-af',description])).toThrow(/Native packet scheduling/);
});
it('retains Native demux-seek and negative output timestamp gaps with rate conversion',()=>{
 expect(()=>compile(['-ss','0.001'],['-ar','16000'])).toThrow(/demux seeking/);
 expect(()=>compile([],['-ss','-0.001','-ar','16000'])).toThrow(/Negative FLAC output/);
});
it('distinguishes zero input recording time from zero output recording time',()=>{
 const plan=compile(['-t','0'],['-t','0','-ar','16000']);
 const input=resolveFlacTimePolicy({input:plan.time.input,output:{seek:0n,duration:null,stop:null}},8000,257n);
 const target=resolveFlacTimePolicy({input:{seek:0n,duration:null,stop:null},output:plan.time.output},16000,null);
 expect(input.endSampleExclusive).toBe(257n);expect(target.endSampleExclusive).toBe(0n);
});
it('resolves recording scopes at their respective rates without using a scaled source total',()=>{
 const plan=compile(['-t','0.003'],['-ss','0.001','-t','0.002','-ar','16000']);
 const input=resolveFlacTimePolicy({input:plan.time.input,output:{seek:0n,duration:null,stop:null}},8000,257n);
 const target=resolveFlacTimePolicy({input:{seek:0n,duration:null,stop:null},output:plan.time.output},16000,null);
 // A 24-sample finite input produces 40 FIR output samples, not the naive 48.
 expect(input).toEqual({startSample:0n,endSampleExclusive:24n,outputPtsSamples:0n});
 expect(countResampledFlacSamples(input.endSampleExclusive!,8000,16000)).toBe(40n);
 expect(target).toEqual({startSample:16n,endSampleExclusive:48n,outputPtsSamples:0n});
 const unlimited=compile([],['-ss','0.001','-ar','16000']);
 expect(resolveFlacTimePolicy({input:{seek:0n,duration:null,stop:null},output:unlimited.time.output},16000,null).endSampleExclusive).toBeNull();
});
