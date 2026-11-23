import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {schedulePacketSections,resamplePacketSchedule} from '../../packages/avformat/src/packet-schedule.js';
import {pcmPacketSpan} from '../../packages/avformat/src/time-range.js';
it('plans native automatic resampler packet lengths across startup rational phases and EOF draining',()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-packets-'));
  try{
    for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48001],[48001,44100],[8000,16001],[100,8000],[8000,100],[1,8000]])for(const samples of [0,1,21,24,33,65,257,1539])for(const span of [pcmPacketSpan(inputRate!),1n,7n,32n]){
      if(inputRate===1&&samples!>65)continue;
      const sourceSamples=inputRate===8000&&outputRate===100&&samples===1539?4097:samples!;
      writeFileSync(join(root,'input.raw'),new Uint8Array(sourceSamples*2));
      const filter=span===pcmPacketSpan(inputRate!)?[]:['-af',`asetnsamples=${span}:p=0`];
      const text=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f','s16le','-ar',String(inputRate),'-ac','1','-i',join(root,'input.raw'),...filter,'-ar',String(outputRate),'-c:a','pcm_f64le','-bitexact','-f','framecrc','-'],{encoding:'utf8'});
      const expected=text.split('\n').filter(line=>line.startsWith('0,')).map(line=>BigInt(line.split(',')[3]!.trim())),source=schedulePacketSections(sourceSamples?[{samples:BigInt(sourceSamples),span}]:[]),plan=resamplePacketSchedule(source,inputRate!,outputRate!),label=`${samples}/${inputRate}->${outputRate}/${span}`;
      expect(plan.packetCount,label).toBe(BigInt(expected.length));let sum=0n;for(let index=0;index<expected.length;index++){sum+=expected[index]!;expect(plan.samplesForPackets(BigInt(index+1)),`${label}/${index}`).toBe(sum);}expect(plan.sampleCount,label).toBe(sum);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
