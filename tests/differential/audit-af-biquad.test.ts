import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
it('audit-af biquad: float-sensitive probes against native',async()=>{
  const tmp=await harness('bqz',{'u8.raw':pcm(1,false,20000*5),'s16.raw':pcm(2,false,20000*5),'s32.raw':pcm(4,false,20000*5),'f32.raw':pcm(4,true,20000*5),'f64.raw':pcm(8,true,20000*5)});
  tmp.make(['-f','s16le','-ar','44100','-ac','2','-i',join(tmp.root,'s16.raw'),'-bitexact'],'s16.wav');
  const srcs=[['u8','u8.raw'],['s16le','s16.raw'],['s32le','s32.raw'],['f32le','f32.raw'],['f64le','f64.raw']] as const;
  const direct=['a1=-1.9999:a2=0.99995:b0=0.00001:b1=0.00002:b2=0.00001','a0=0.3:a1=0.48:a2=0.21:b0=1000:b1=-7:b2=3','a1=-0.7:a2=0.1:b0=0.3:b1=0.2:b2=0.1000005:n=1:m=0.37','a1=1.6:a2=0.7:b0=0.5:b1=-0.25:b2=0.7'];
  const zdf=['a0=0.5:a1=0.49:a2=0.45:b0=0.1:b1=0.2:b2=0.1','a0=0.3:a1=0.21:a2=0.17:b0=1000:b1=-7:b2=3:m=0.37'];
  const cases:Case[]=[];let k=0;
  for(const t of ['dii','tdi','tdii','latt','svf','zdf'])for(const set of t==='zdf'?zdf:direct)for(const p of ['auto','s16','s32','f32','f64']){
    const [f,file]=srcs[k%5]!,rate=[11025,96000,8000][k%3]!,ch=[1,2,5][k%3]!;k++;
    cases.push({id:`${t}/${set}/${p}/${f}/${rate}/${ch}`,before:['-cpuflags','0','-f',f,'-ar',String(rate),'-ac',String(ch)],input:file,after:['-af',`biquad=${set}:a=${t}:r=${p}`,'-c:a',f==='s16le'?'pcm_s16le':'pcm_f64le','-f',f==='s16le'?'s16le':'f64le']});
  }
  for(const t of ['dii','tdii','latt','zdf'])for(const p of ['s16p','s32p','fltp','dblp','u8','s32'])cases.push({id:`aformat-${p}/${t}`,before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2'],input:'s16.raw',after:['-af',`aformat=sample_fmts=${p},biquad=${t==='zdf'?zdf[0]:direct[2]}:a=${t}`,'-c:a','pcm_s16le','-f','s16le']});
  for(const ss of ['0.013','0.21'])cases.push({id:`in-ss/${ss}`,before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-ss',ss,'-t','0.3'],input:'s16.raw',after:['-af',`biquad=${direct[0]}:a=tdii`,'-c:a','pcm_s16le','-bitexact','-f','framecrc']});
  cases.push({id:'wav-ss',before:['-cpuflags','0','-ss','0.0371'],input:'s16.wav',after:['-af',`biquad=${direct[1]}:a=svf:r=s16`,'-c:a','pcm_s16le','-f','wav','-bitexact']});
  cases.push({id:'split',before:['-cpuflags','0','-f','f32le','-ar','8000','-ac','2'],input:'f32.raw',after:['-af',`asetnsamples=n=3:p=0,biquad=${direct[3]}:a=latt,asetnsamples=n=13:p=0`,'-c:a','pcm_f32le','-f','f32le']});
  cases.push({id:'chain',before:['-cpuflags','0','-f','s32le','-ar','8000','-ac','2'],input:'s32.raw',after:['-af',`biquad=${direct[0]}:a=dii:r=s32,biquad=${zdf[1]}:a=zdf:r=f32,volume=0.5`,'-c:a','pcm_s32le','-f','s32le']});
  await runAll('biquad',tmp,cases);
},900000);
