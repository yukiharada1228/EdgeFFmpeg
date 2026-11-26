import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
it('audit-af aphaser: float-sensitive probes against native',async()=>{
  const ext=new Uint8Array(12000*4*2),v=new DataView(ext.buffer);for(let i=0;i<12000*2;i++)v.setInt32(i*4,((i>>5)%3===0)?2147483647:((i>>5)%3===1)?-2147483648:(i*7919)|0,true);
  const e16=new Uint8Array(12000*2*2),w=new DataView(e16.buffer);for(let i=0;i<12000*2;i++)w.setInt16(i*2,((i>>5)%3===0)?32767:((i>>5)%3===1)?-32768:(i*7919)&0x7fff,true);
  const tmp=await harness('aph',{'u8.raw':pcm(1,false,16000*8),'s16.raw':pcm(2,false,16000*8),'s32.raw':pcm(4,false,16000*8),'f32.raw':pcm(4,true,16000*8),'f64.raw':pcm(8,true,16000*8),'ext.raw':ext,'e16.raw':e16});
  tmp.make(['-f','s16le','-ar','44100','-ac','2','-i',join(tmp.root,'s16.raw'),'-bitexact'],'s16.wav');
  const srcs=[['u8','u8.raw'],['s16le','s16.raw'],['s32le','s32.raw'],['f32le','f32.raw'],['f64le','f64.raw']] as const;
  const chains=['aphaser','aphaser=in_gain=0.3:out_gain=1:decay=0.7','aphaser=in_gain=0.37:out_gain=1.59:decay=0.41:speed=1.7:delay=4.4','aphaser=in_gain=0.01:out_gain=1:decay=0.99:speed=0.1','aphaser=in_gain=0.9:out_gain=0.111:delay=0.0625:speed=2','aphaser=delay=0.1875:decay=0.33:speed=0.33'];
  const cases:Case[]=[];let k=0;
  for(const c of chains)for(const rate of [11025,22050,48000,96000,7919])for(const ch of [1,2,5,8]){const [f,file]=srcs[k++%5]!;cases.push({id:`${c}/${rate}/${ch}/${f}`,before:['-cpuflags','0','-f',f,'-ar',String(rate),'-ac',String(ch)],input:file,after:['-af',c,'-c:a','pcm_f64le','-f','f64le']});}
  for(const p of ['s16p','s32p','fltp','dblp','flt','s32','s16','dbl'])for(const [f,file]of [srcs[1],srcs[4]])cases.push({id:`aformat-${p}/${f}`,before:['-cpuflags','0','-f',f,'-ar','44100','-ac','2'],input:file,after:['-af',`aformat=sample_fmts=${p},aphaser=in_gain=0.37:out_gain=1.59:decay=0.41`,'-c:a','pcm_s16le','-f','s16le']});
  for(const c of ['aphaser=in_gain=0.3:out_gain=1:decay=0.7','aphaser=in_gain=0.01:out_gain=1:decay=0.99','aphaser=in_gain=0.6:out_gain=0.8:decay=0.52','aphaser=in_gain=0.000000001:out_gain=1000000000:decay=0'])for(const [file,f,codec]of [['ext.raw','s32le','pcm_s32le'],['e16.raw','s16le','pcm_s16le']])cases.push({id:`bound/${c}/${f}`,before:['-cpuflags','0','-f',f,'-ar','44100','-ac','2'],input:file,after:['-af',c,'-c:a',codec,'-f',f]});
  for(const ss of ['0.013','0.21'])cases.push({id:`in-ss/${ss}`,before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-ss',ss,'-t','0.3'],input:'s16.raw',after:['-af','aphaser=decay=0.7:in_gain=0.25','-c:a','pcm_s16le','-bitexact','-f','framecrc']});
  cases.push({id:'wav-ss',before:['-cpuflags','0','-ss','0.0371'],input:'s16.wav',after:['-af','aphaser=speed=1.3:delay=2.2','-c:a','pcm_s16le','-f','wav','-bitexact']});
  cases.push({id:'split',before:['-cpuflags','0','-f','f32le','-ar','8000','-ac','2'],input:'f32.raw',after:['-af','asetnsamples=n=3:p=0,aphaser=decay=0.6:in_gain=0.37,asetnsamples=n=13:p=0','-c:a','pcm_f32le','-f','f32le']});
  cases.push({id:'out-ss',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','aphaser=decay=0.6:in_gain=0.37','-ss','0.3','-t','0.4','-c:a','pcm_s16le','-bitexact','-f','framecrc']});
  await runAll('aphaser',tmp,cases);
},900000);
