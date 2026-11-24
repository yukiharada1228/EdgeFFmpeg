import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
/** Float sources depend on the native float-to-s32 conversion; they are pinned on the Linux x86_64 reference only. */
const floatCases=process.platform==='linux'&&process.arch==='x64';
const sources=[['u8',1],['s16le',2],['s32le',4],...(floatCases?[['f32le',4],['f64le',8]]:[])] as [string,number][];
const shifts=['0','0.3','-0.7','1','-1'],gains=['0','0.4','1'];
/** Deterministic PCM: integer extremes (INT_MIN, INT_MAX, near the limiter thresholds) then mixed bytes; floats within |x| <= 1.1 with exact +-1, +-1.1 and -0. */
function pcm(raw:string,width:number,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  const s32=[-2147483648,2147483647,-2147483647,0,-1,1,1288490188,-1288490188,1288490189,1717986918,-1717986918,1073741823,-1073741824,429496729,-429496730,2147483646];
  const ints:Record<string,number[]>={u8:[0,255,1,128,127,254],s16le:[-32768,32767,-32767,0,-1,1,26214,-26214],s32le:s32},floats=[-1.1,1.1,-1,1,-0,0.3,-0.7,0.999999,-0.999999,0.6,-0.6];
  for(let i=0;i<count;i++){
    if(raw==='f32le'||raw==='f64le'){const value=i<floats.length?floats[i]!:Math.sin(i*0.731)*1.1*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);continue;}
    const fixed=ints[raw]!;
    if(i<fixed.length){const value=fixed[i]!;if(width===1)view.setUint8(i,value);else if(width===2)view.setInt16(i*2,value,true);else view.setInt32(i*4,value,true);}
    else for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);
  }
  return data;
}
async function harness(prefix:string,budget=65536){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:10000}})};
}
it('matches native dcshift s32 raw, s32 WAV, s16 WAV and framecrc bytes for every shift and limiter gain on integer and float sources',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-dcshift-');let index=0,compared=0;
  try{
    const outputs=[['s32le',['-c:a','pcm_s32le','-f','s32le']],['s32.wav',['-c:a','pcm_s32le','-bitexact','-f','wav']],['s16.wav',['-c:a','pcm_s16le','-bitexact','-f','wav']],['crc',['-c:a','pcm_s32le','-bitexact','-f','framecrc']]] as const;
    for(const [raw,width]of sources){
      writeFileSync(join(root,`${raw}.raw`),pcm(raw,width,1201*2));
      for(const shift of shifts)for(const gain of gains)for(const [kind,args]of outputs){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],after=['-af',`dcshift=${shift}:${gain}`,...args],name=`/${index++}.${kind}`,reference=join(root,`reference-${name.slice(1)}`);
        execFileSync(native,['-v','error','-y',...before,'-i',join(root,`${raw}.raw`),...after,reference]);
        const result=await frontend.exec([...before,'-i',`/${raw}.raw`,...after,name]);
        expect(result.exitCode,JSON.stringify({raw,shift,gain,kind,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${shift}/${gain}/${kind}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(sources.length*shifts.length*gains.length*outputs.length);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native dcshift chains with volume and asetnsamples, named options, mono and three-channel input and output time selection',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-dcshift-chain-');let index=0;
  try{
    const chains=['volume=0.5,dcshift=0.3:0.4','dcshift=-0.7:1,volume=0.5','dcshift=shift=1:limitergain=0.4,asetnsamples=7','asetnsamples=7,dcshift=limitergain=1:shift=-1','dcshift=-0.7,volume=0.5:precision=fixed,asetnsamples=7:p=0','dcshift','dcshift=0.3,dcshift=-0.7:0.4'];
    const selections=[[],['-ss','0.01','-t','0.02'],['-frames:a','3'],['-t','0.001']];
    for(const [raw,width]of sources)for(const channels of [1,3]){
      writeFileSync(join(root,`${raw}.raw`),pcm(raw,width,523*channels));
      for(const chain of chains)for(const selection of selections)for(const codec of ['pcm_s32le','pcm_s16le','pcm_f64le']){
        const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',chain,...selection,'-c:a',codec,'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,`${raw}.raw`),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${raw}.raw`,...after,out]);
        expect(result.exitCode,JSON.stringify({raw,channels,chain,selection,codec,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${channels}/${chain}/${selection.join(' ')}/${codec}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses out-of-range options, expressions, enable and unknown options before writing output, where native also fails or accepts unimplemented forms',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-dcshift-refuse-');let index=0;
  try{
    writeFileSync(join(root,'input.raw'),pcm('s16le',2,64));
    const run=async(filter:string)=>{const before=['-f','s16le','-ar','8000','-ac','1'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw','-af',filter,'-f','framecrc',out]);return {result,out,status:spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),'-af',filter,'-f','framecrc','-']).status};};
    // Native fails these too.
    for(const filter of ['dcshift=2','dcshift=limitergain=-1','dcshift=-1.5:0.5','dcshift=0:1.5','dcshift=0.1:0.2:0.3','dcshift=foo=1']){const {result,out,status}=await run(filter);expect(status,filter).not.toBe(0);expect(result.exitCode,filter).not.toBe(0);expect(existsSync(join(root,out.slice(1))),filter).toBe(false);}
    // Native evaluates these (expressions, suffixes, timeline enable); they stay unimplemented and are refused rather than approximated.
    for(const filter of ['dcshift=0.1+0.1','dcshift=shift=PI/10','dcshift=0.5:limitergain=1/4','dcshift=0.1:enable=1']){const {result,out,status}=await run(filter);expect(status,filter).toBe(0);expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics[0]?.code,filter).toBe('unsupported-filter');expect(existsSync(join(root,out.slice(1))),filter).toBe(false);}
    // Fixed volume before dcshift on s16 input: native keeps volume in s16 and converts to s32p after it; the pre-registry fixed-volume rule cannot reproduce that merge, so the chain refuses.
    {const filter='volume=0.5:precision=fixed,dcshift=-0.7',{result,out,status}=await run(filter);expect(status).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toBe('dcshift with s16 input requires unimplemented format negotiation');expect(existsSync(join(root,out.slice(1)))).toBe(false);}
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
