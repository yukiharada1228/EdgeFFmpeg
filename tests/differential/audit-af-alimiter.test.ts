import {it} from 'vitest';
import {join} from 'node:path';
import {harness,pcm,runAll,type Case} from './audit-af-harness.js';
function sig(count:number,channels:number,kind:number):Uint8Array{
  const a=new Float64Array(count*channels);
  for(let i=0;i<count;i++)for(let c=0;c<channels;c++){
    let v:number;
    if(kind===0)v=(i%2?-1:1)*Math.min(3,0.01+(i%997)*0.003)*(1+c*0.05);           // rising alternating peaks, long chains
    else if(kind===1)v=(i%37===0)?1.7:(i%37===1?-1.7:0.2*Math.sin(i));               // equal bursts (ties)
    else if(kind===2)v=i===300?NaN:i===700?Infinity:i===900?-Infinity:i===1200?1e308:Math.sin(i*0.3)*1.2; // non-finite
    else v=Math.sin(i*0.01*(c+1))*(1+(i%500)/100);                                    // smooth over limit
    a[i*channels+c]=v;
  }
  return new Uint8Array(a.buffer);
}
it('audit-af alimiter: probes against native',async()=>{
  const files:Record<string,Uint8Array>={'s16.raw':pcm(2,false,12000*2)};
  for(const ch of [1,2,6])for(const k of [0,1,2,3])files[`k${k}c${ch}.raw`]=sig(12000,ch,k);
  const tmp=await harness('alz',files);
  tmp.make(['-f','f64le','-ar','44100','-ac','6','-i',join(tmp.root,'k3c6.raw'),'-c:a','pcm_s16le','-bitexact'],'six.wav');
  const F64=['-c:a','pcm_f64le','-f','f64le'];
  const raw=(r:number,ch:number)=>['-cpuflags','0','-f','f64le','-ar',String(r),'-ac',String(ch)];
  const cases:Case[]=[];
  for(const att of ['0.125','0.126','0.13','0.2','0.25','0.3','0.5'])for(const ch of [1,2])for(const k of [0,1,3])
    cases.push({id:`tiny-att${att}-c${ch}-k${k}`,before:raw(8000,ch),input:`k${k}c${ch}.raw`,after:['-af',`alimiter=attack=${att}:limit=0.3:release=1`,...F64]});
  for(const k of [0,1,2,3])for(const ch of [1,2,6])cases.push({id:`k${k}-c${ch}`,before:raw(44100,ch),input:`k${k}c${ch}.raw`,after:['-af','alimiter=limit=0.25:attack=2:release=3',...F64]});
  cases.push({id:'nonfinite-s16out',before:raw(44100,2),input:'k2c2.raw',after:['-af','alimiter=limit=0.5','-c:a','pcm_s16le','-f','s16le']});
  for(const r of [1000,11025,96000,192000])cases.push({id:`rate${r}`,before:raw(r,2),input:'k0c2.raw',after:['-af','alimiter=limit=0.2:attack=1',...F64]});
  cases.push({id:'six-wav',before:['-cpuflags','0'],input:'six.wav',after:['-af','alimiter=limit=0.1',...F64]});
  cases.push({id:'six-wav-ss',before:['-cpuflags','0','-ss','0.05'],input:'six.wav',after:['-af','alimiter=limit=0.1:attack=0.3',...F64]});
  cases.push({id:'s16-level64',before:['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],input:'s16.raw',after:['-af','alimiter=level_in=64:limit=0.0625:level=0:level_out=64',...F64]});
  for(const [c,f] of [['pcm_u8','u8'],['pcm_s32le','s32le'],['pcm_f32le','f32le'],['pcm_s24le','s24le']])cases.push({id:`out-${c}`,before:raw(8000,2),input:'k0c2.raw',after:['-af','alimiter=limit=0.7:level=0','-c:a',c,'-f',f]});
  cases.push({id:'aformat-flt',before:raw(8000,2),input:'k0c2.raw',after:['-af','aformat=sample_fmts=flt,alimiter=limit=0.3,aformat=sample_fmts=flt',...F64]});
  cases.push({id:'twice',before:raw(8000,1),input:'k0c1.raw',after:['-af','alimiter=limit=0.9:attack=0.5,alimiter=limit=0.3:attack=11:release=2',...F64]});
  cases.push({id:'in-ss-t',before:[...raw(8000,1),'-ss','0.1','-t','0.5'],input:'k1c1.raw',after:['-af','alimiter=limit=0.3',...F64]});
  cases.push({id:'out-ss',before:raw(8000,1),input:'k1c1.raw',after:['-af','alimiter=limit=0.3','-ss','0.2','-t','0.1','-c:a','pcm_f64le','-bitexact','-f','framecrc']});
  cases.push({id:'neg0-ascl',before:raw(8000,1),input:'k1c1.raw',after:['-af','alimiter=asc_level=-0:limit=0.3:level=off',...F64]});
  cases.push({id:'bool-forms',before:raw(8000,1),input:'k1c1.raw',after:['-af','alimiter=asc=No:latency=FALSE:level=+0:limit=0.3',...F64]});
  cases.push({id:'one-sample',before:[...raw(8000,1),'-t','0.000125'],input:'k1c1.raw',after:['-af','alimiter=limit=0.3',...F64]});
  await runAll('alimiter',tmp,cases);
},900000);
