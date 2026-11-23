import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {PackedSampleFormat} from '@edge-ffmpeg/swresample';
it('matches native automatic rate placement across mixed precision and asetrate filter boundaries',()=>{
  const cases:[PackedSampleFormat,PackedSampleFormat,string,number][]=[
    ['s16','s16','volume=0.5:precision=double',1],
    ['s16','dbl','volume=0.5:precision=double,asetnsamples=7:p=1',0],
    ['dbl','dbl','volume=0.5:precision=float,volume=0.5:precision=double',1],
    ['dbl','s16','volume=0.5:precision=fixed',0],
    ['s16','dbl','volume=0.5:precision=double,asetrate=11025',2],
    ['s16','dbl','asetrate=11025,volume=0.5:precision=double',1],
    ['dbl','dbl','volume=0.5:precision=float,asetrate=11025,volume=0.5:precision=double',2]
  ];
  const raw={s16:'s16le',dbl:'f64le',flt:'f32le',u8:'u8',s32:'s32le'},width={s16:2,dbl:8,flt:4,u8:1,s32:4};
  for(const [source,target,description,index]of cases){
    const result=spawnSync(resolve('.build/reference/ffmpeg'),['-v','verbose','-cpuflags','0','-f',raw[source],'-ar','8000','-ac','1','-i','pipe:0','-af',description,'-ar','16000','-f',raw[target],'-'],{input:new Uint8Array(257*width[source]),encoding:null});expect(result.status).toBe(0);
    const log=result.stderr.toString(),transitions=[...log.matchAll(/\[(auto_aresample_\d+) @[^\n]*fmt:(\w+) r:(\d+)Hz ->[^\n]*fmt:(\w+) r:(\d+)Hz/g)].filter(match=>match[3]!==match[5]);expect(transitions).toHaveLength(1);
    const transition=transitions[0]!,boundary=compileAudioFilterChain(description,{outputSampleFormat:target}).rateBoundary(source,8000,16000);expect(boundary).toEqual({beforeStep:index,inputRate:Number(transition[3]),outputRate:Number(transition[5]),inputFormat:transition[2],outputFormat:transition[4]});
    const destination=index===description.split(',').length?'format_out_#0:0':`Parsed_${description.split(',')[index]!.split('=')[0]}_${index}`;
    const insertion=log.split('\n').find(line=>line.includes(`auto-inserting filter '${transition[1]}'`));expect(insertion,description).toContain(`and the filter '${destination}'`);
  }
});
