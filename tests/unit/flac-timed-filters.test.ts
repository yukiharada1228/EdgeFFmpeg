import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {compileFlacTransform} from '../../packages/avformat/src/flac-transform.js';

const output={format:'s16le',codec:'pcm_s16le'} as const;
const compile=(options:readonly string[],input:readonly string[]=[],global:readonly string[]=[])=>compileFlacTransform(parseArgv([...global,...input,'-i','/in.flac',...options,'/out.pcm']),output);

it.each(['anull','volume=0.5','anull,volume=0.5,volume=2,anull'])('allows output time selection before sample-local FLAC filters: %s',description=>{
 const plan=compile(['-ss','0.001','-t','0.002','-af',description],[],['-cpuflags','0']);
 expect(plan?.timed).toBe(true);expect(plan?.rate).toBeNull();expect(plan?.filters?.steps.length).toBe(description.split(',').length);
 expect(plan?.scalar).toBe(true);expect(Object.isFrozen(plan)).toBe(true);
});
it.each(['-af','-filter:a','-filter:a:0'])('allows input duration and sample-local filters through %s',alias=>{
 const plan=compile([alias,'anull,volume=0.5'],['-t','0.002']);
 expect(plan?.timed).toBe(true);expect(plan?.filters?.steps.map(step=>step.name)).toEqual(['anull','volume']);
 // Admission must not silently select a different arithmetic profile.
 expect(plan?.scalar).toBe(false);expect(plan?.filters?.requiresScalarRounding('s32')).toBe(true);
});
it.each(['asetrate=8000'])('retains timed FLAC scheduling rejection for %s',description=>{
 expect(()=>compile(['-t','0.002','-af',description])).toThrow(/Native packet scheduling/);
});
it.each(['-ar','-ar:a','-ar:a:0'])('allows timed explicit rate conversion with only anull: %s',alias=>{
 expect(compile(['-t','0.002',alias,'8000','-af','anull'])?.rate).toBe(8000);
});
it('keeps non-timed buffering filters available and an unchanged command outside the advanced transform',()=>{
 expect(compile(['-af','apad=pad_len=7'])?.filters?.steps[0]?.name).toBe('apad');
 expect(compile([])).toBeNull();
});
it('rejects invalid filter syntax rather than treating timed filtering as a no-op',()=>{
 expect(()=>compile(['-t','0.002','-af','volume=not-a-number'])).toThrow();
});

it.each(['atrim=start_sample=0','asetpts=PTS'])('retains unsupported filter syntax rejection with time selection: %s',description=>{
 expect(()=>compile(['-t','0.002','-af',description])).toThrow(/Unsupported audio filter/);
});
