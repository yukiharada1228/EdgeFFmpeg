import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
it('audit-af apulsator: float-sensitive probes against native',async()=>{
  const tmp=await harness('apz',{'u8.raw':pcm(1,false,20000*2),'s16.raw':pcm(2,false,20000*2),'s32.raw':pcm(4,false,20000*2),'f32.raw':pcm(4,true,20000*2),'f64.raw':pcm(8,true,20000*2)});
  tmp.make(['-f','f64le','-ar','48000','-ac','2','-i',join(tmp.root,'f64.raw'),'-c:a','pcm_f32le','-bitexact'],'f32.wav');
  tmp.make(['-f','s16le','-ar','44100','-ac','2','-i',join(tmp.root,'s16.raw'),'-bitexact'],'s16.wav');
  const srcs=[['u8','u8.raw'],['s16le','s16.raw'],['s32le','s32.raw'],['f32le','f32.raw'],['f64le','f64.raw']] as const,F64=['-c:a','pcm_f64le','-f','f64le'];
  const cases:Case[]=[];let k=0;
  for(const mode of ['triangle','square','sawup','sawdown'])for(const amount of ['0.37','0.6','0.999'])for(const timing of ['timing=hz:hz=0.37','timing=bpm:bpm=77.7','timing=ms:ms=333','timing=hz:hz=100'])for(const w of ['width=0.3:offset_l=0.13:offset_r=0.77','width=1.7:offset_l=0.9:offset_r=0.05']){
    const [f,file]=srcs[k%5]!,rate=[11025,22050,96000,7,8000][k%5]!;k++;
    cases.push({id:`${mode}/${amount}/${timing}/${w}/${f}/${rate}`,before:['-cpuflags','0','-f',f,'-ar',String(rate),'-ac','2'],input:file,after:['-af',`apulsator=mode=${mode}:amount=${amount}:${timing}:${w}`,...F64]});
  }
  for(const lv of ['level_in=0.7:level_out=1.3','level_in=13.7:level_out=0.031','level_in=0.015625:level_out=63.9'])for(const [f,file]of srcs)cases.push({id:`levels/${lv}/${f}`,before:['-cpuflags','0','-f',f,'-ar','44100','-ac','2'],input:file,after:['-af',`apulsator=mode=sawup:amount=0.71:${lv}`,...F64]});
  for(const [c,o]of [['pcm_s16le','s16le'],['pcm_u8','u8'],['pcm_s32le','s32le'],['pcm_f32le','f32le'],['pcm_s24le','s24le']])cases.push({id:`out/${c}`,before:['-cpuflags','0','-f','f64le','-ar','48000','-ac','2'],input:'f64.raw',after:['-af','apulsator=mode=triangle:amount=0.6:level_out=3','-c:a',c,'-f',o]});
  for(const ss of ['0.013','0.21'])cases.push({id:`in-ss/${ss}`,before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-ss',ss,'-t','0.2'],input:'s16.raw',after:['-af','apulsator=mode=triangle:amount=0.5',...F64]});
  cases.push({id:'wav-ss',before:['-cpuflags','0','-ss','0.0371'],input:'s16.wav',after:['-af','apulsator=mode=square:amount=0.3',...F64]});
  cases.push({id:'wav-f32',before:['-cpuflags','0'],input:'f32.wav',after:['-af','apulsator=mode=sawdown:amount=0.45:width=0.7','-c:a','pcm_f32le','-f','wav','-bitexact']});
  cases.push({id:'long-drift',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','apulsator=mode=triangle:amount=0.6:hz=0.01',...F64]});
  cases.push({id:'chain-aformat',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','aformat=sample_fmts=fltp,apulsator=mode=sawup:amount=0.6,aformat=sample_fmts=s16','-c:a','pcm_s16le','-f','s16le']});
  cases.push({id:'chain-split',before:['-cpuflags','0','-f','f32le','-ar','8000','-ac','2'],input:'f32.raw',after:['-af','asetnsamples=n=3:p=0,apulsator=mode=triangle:amount=0.6,asetnsamples=n=11:p=0,apulsator=mode=square:amount=0.2','-c:a','pcm_f64le','-bitexact','-f','framecrc']});
  cases.push({id:'out-ss',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','apulsator=mode=sawdown:amount=0.6','-ss','0.3','-t','0.4','-c:a','pcm_f64le','-bitexact','-f','framecrc']});
  await runAll('apulsator',tmp,cases);
},900000);
