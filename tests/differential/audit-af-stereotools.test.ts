import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
it('audit-af stereotools: float-sensitive probes against native',async()=>{
  const z=new Float64Array(6000*2);for(let i=0;i<z.length;i++)z[i]=i%3===0?-0:i%3===1?0:(i%7-3)*0.25;
  const tmp=await harness('stz',{'s16.raw':pcm(2,false,20000*2),'f64.raw':pcm(8,true,20000*2),'u8.raw':pcm(1,false,20000*2),'z.raw':new Uint8Array(z.buffer)});
  tmp.make(['-f','s16le','-ar','44100','-ac','2','-i',join(tmp.root,'s16.raw'),'-bitexact'],'s16.wav');
  const F64=['-c:a','pcm_f64le','-f','f64le'];
  const modes=['lr>lr','lr>ms','ms>lr','lr>ll','lr>rr','lr>l+r','lr>rl','ms>ll','ms>rr','ms>rl','lr>l-r'];
  const opts=['slev=0.7:mlev=1.3:sbal=0.2:mpan=-0.6','base=0.37','base=-0.81:delay=13.3:slev=2.1','balance_in=-0.77:bmode_in=power:balance_out=0.123:bmode_out=amplitude:level_in=1.7:level_out=0.37'];
  const cases:Case[]=[];let k=0;
  for(const m of modes)for(const o of opts){const [f,file,rate]=([['s16le','s16.raw',11025],['f64le','f64.raw',96000],['u8','u8.raw',101],['s16le','s16.raw',1]] as const)[k++%4]!;cases.push({id:`${m}/${o}/${f}/${rate}`,before:['-cpuflags','0','-f',f,'-ar',String(rate),'-ac','2'],input:file,after:['-af',`stereotools=mode=${m}:${o}`,...F64]});}
  for(const b of ['balance','amplitude','power'])for(const v of ['-0.77','0.123','-0.001','0.999'])cases.push({id:`bal/${b}/${v}`,before:['-cpuflags','0','-f','f64le','-ar','44100','-ac','2'],input:'f64.raw',after:['-af',`stereotools=bmode_in=${b}:balance_in=${v}:bmode_out=${b}:balance_out=${v}:mlev=0.9:mode=ms>lr`,...F64]});
  for(const o of ['phase=-0:mutel=1:slev=0.7:mlev=1.3','phase=-0:muter=1:base=0.37:delay=-3','phase=-0:phasel=1:balance_in=0.3'])for(const file of ['z.raw','f64.raw'])cases.push({id:`negphase/${o}/${file}`,before:['-cpuflags','0','-f','f64le','-ar','8000','-ac','2'],input:file,after:['-af',`stereotools=${o}`,...F64]});
  for(const [c,o]of [['pcm_s16le','s16le'],['pcm_u8','u8'],['pcm_s32le','s32le'],['pcm_f32le','f32le']])cases.push({id:`out/${c}`,before:['-cpuflags','0','-f','f64le','-ar','48000','-ac','2'],input:'f64.raw',after:['-af','stereotools=mode=ms>lr:slev=3:mlev=0.6:base=0.2:level_out=2.5','-c:a',c,'-f',o]});
  cases.push({id:'in-ss',before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-ss','0.0371','-t','0.2'],input:'s16.raw',after:['-af','stereotools=delay=17.7:base=-0.4:slev=1.3',...F64]});
  cases.push({id:'wav-ss',before:['-cpuflags','0','-ss','0.05'],input:'s16.wav',after:['-af','stereotools=mode=lr>ms:sbal=0.31:mlev=0.77','-c:a','pcm_s16le','-f','wav','-bitexact']});
  cases.push({id:'chain',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','asetnsamples=n=3:p=0,stereotools=delay=20:base=0.5:mlev=0.4,stereotools=delay=-20:mode=ms>rl:slev=1.9','-c:a','pcm_f64le','-bitexact','-f','framecrc']});
  await runAll('stereotools',tmp,cases);
},900000);
