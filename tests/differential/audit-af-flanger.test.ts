import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
it('audit-af flanger: float-sensitive probes against native',async()=>{
  const tmp=await harness('flz',{'u8.raw':pcm(1,false,16000*5),'s16.raw':pcm(2,false,16000*5),'s32.raw':pcm(4,false,16000*5),'f32.raw':pcm(4,true,16000*5),'f64.raw':pcm(8,true,16000*5)});
  tmp.make(['-f','s16le','-ar','44100','-ac','2','-i',join(tmp.root,'s16.raw'),'-bitexact'],'s16.wav');
  const srcs=[['u8','u8.raw'],['s16le','s16.raw'],['s32le','s32.raw'],['f32le','f32.raw'],['f64le','f64.raw']] as const;
  const cases:Case[]=[];let k=0;
  const delays=['0','0.0625','0.1875','1.7','13.3','30'],depths=['0','0.5','3.3','10'],regens=['-95','-33','0','61','95'],widths=['0','37','71','100'],speeds=['0.1','0.77','10'],phases=['0','37','100'];
  for(const d of delays)for(const dp of depths){
    const r=regens[k%5]!,wd=widths[k%4]!,s=speeds[k%3]!,ph=phases[k%3]!,interp=k%2?'quadratic':'linear',[f,file]=srcs[k%5]!,rate=[11025,22050,48000,96000,7919,8000][k%6]!,ch=[1,2,5][k%3]!;k++;
    cases.push({id:`${d}/${dp}/${r}/${wd}/${s}/${ph}/${interp}/${f}/${rate}/${ch}`,before:['-cpuflags','0','-f',f,'-ar',String(rate),'-ac',String(ch)],input:file,after:['-af',`flanger=shape=t:delay=${d}:depth=${dp}:regen=${r}:width=${wd}:speed=${s}:phase=${ph}:interp=${interp}`,'-c:a','pcm_f64le','-f','f64le']});
  }
  for(const rate of [8000,48000,44100])for(const d of ['0.0625','0.1875','0.3125','0.03125','0.052'])cases.push({id:`rint/${rate}/${d}`,before:['-cpuflags','0','-f','s16le','-ar',String(rate),'-ac','2'],input:'s16.raw',after:['-af',`flanger=shape=t:delay=${d}:depth=0.0625:regen=40:speed=3`,'-c:a','pcm_f64le','-f','f64le']});
  for(const [c,o]of [['pcm_s16le','s16le'],['pcm_u8','u8'],['pcm_s32le','s32le'],['pcm_f32le','f32le']])cases.push({id:`out/${c}`,before:['-cpuflags','0','-f','f64le','-ar','48000','-ac','2'],input:'f64.raw',after:['-af','flanger=shape=t:regen=80:width=100:depth=7','-c:a',c,'-f',o]});
  for(const ss of ['0.013','0.21'])cases.push({id:`in-ss/${ss}`,before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-ss',ss,'-t','0.3'],input:'s16.raw',after:['-af','flanger=shape=t:delay=5:depth=4:regen=50','-c:a','pcm_s16le','-bitexact','-f','framecrc']});
  cases.push({id:'wav-ss',before:['-cpuflags','0','-ss','0.0371'],input:'s16.wav',after:['-af','flanger=shape=t:interp=quadratic:speed=7','-c:a','pcm_s16le','-f','wav','-bitexact']});
  cases.push({id:'split',before:['-cpuflags','0','-f','f32le','-ar','8000','-ac','2'],input:'f32.raw',after:['-af','asetnsamples=n=3:p=0,flanger=shape=t:regen=-70:speed=10,asetnsamples=n=13:p=0','-c:a','pcm_f32le','-f','f32le']});
  cases.push({id:'long',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','5'],input:'s16.raw',after:['-af','flanger=shape=t:speed=10:phase=37:depth=10:regen=90','-c:a','pcm_f64le','-f','f64le']});
  await runAll('flanger',tmp,cases);
},900000);
