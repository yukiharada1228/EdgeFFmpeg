import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
// Float arithmetic in the native loop: Linux x86-64 evaluates the plain float formula; other platforms may contract it (fma), so byte comparisons are gated.
const linux=process.platform==='linux'&&process.arch==='x64';
/** Deterministic stereo PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
/** s16 44100 Hz WAV of 64 samples carrying a WAVEFORMATEXTENSIBLE channel `mask`. */
function maskedWav(channels:number,mask:number):Uint8Array {
  const fmt=40,data=64*channels*2,bytes=new Uint8Array(28+fmt+data),view=new DataView(bytes.buffer),text=(at:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[at+index]=value.charCodeAt(index);};
  text(0,'RIFF');view.setUint32(4,20+fmt+data,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,fmt,true);
  view.setUint16(20,0xfffe,true);view.setUint16(22,channels,true);view.setUint32(24,44100,true);view.setUint32(28,44100*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);
  view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,mask>>>0,true);bytes.set([1,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],44);
  text(20+fmt,'data');view.setUint32(24+fmt,data,true);for(let index=0;index<64*channels;index++)view.setInt16(28+fmt+index*2,(index*977)%20000-10000,true);
  return bytes;
}
async function harness(prefix:string,budget=65536){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,filesystem,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
const sweeps=['','feedback=0:crossfeed=0:drymix=1','feedback=0.9:crossfeed=0.8:drymix=0','feedback=0.45:crossfeed=0.15:drymix=0.33'];
it.runIf(linux)('matches native framecrc bytes for delay 1/20/100 ms at 8000/44100/48000 Hz across option sweeps, sources and f32/s16 outputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-stereowiden-');
  let index=0,compared=0;
  try{
    for(const [raw,width]of formats){
      writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),6000*2));
      const full=raw==='s16le'||raw==='f32le';
      for(const rate of [8000,44100,48000])for(const delay of [1,20,100])for(const sweep of full?sweeps:sweeps.slice(1,3))for(const codec of ['pcm_f32le','pcm_s16le']){
        const chain=`stereowiden=delay=${delay}${sweep?`:${sweep}`:''}`,before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac','2'],after=['-af',chain,'-c:a',codec,'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,`${raw}.raw`),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${raw}.raw`,...after,out]);
        expect(result.exitCode,JSON.stringify({raw,rate,chain,codec,diagnostics:result.diagnostics})).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).toString(),`${raw}/${rate}/${chain}/${codec}`).toBe(expected.toString());compared++;
      }
    }
    expect(compared).toBe(2*3*3*4*2+3*3*3*2*2);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native raw and WAV bytes for shorthand options, asetnsamples splits, composed chains and output time selection',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-stereowiden-chains-');
  let index=0;
  try{
    writeFileSync(join(root,'s16.raw'),pcm(2,false,5000*2));writeFileSync(join(root,'f32.raw'),pcm(4,true,5000*2));
    execFileSync(native,['-v','error','-f','s16le','-ar','44100','-ac','2','-i',join(root,'s16.raw'),join(root,'input.wav')]);
    const chains=['stereowiden','stereowiden=7.5:0.6','stereowiden=2.5:0.45:0.65:0.33','asetnsamples=7:p=0,stereowiden=3','asetnsamples=1:p=0,stereowiden=1:0.9:0.8:1','stereowiden=11,asetnsamples=300','asetnsamples=333,stereowiden=13:0.2,asetnsamples=97:p=0','stereowiden=1,stereowiden=99:0.1:0.7:0.2','volume=0.5,stereowiden=5','stereowiden=5,volume=0.5:precision=fixed','stereowiden=4,apad=pad_len=100','aformat=s32,stereowiden=6'];
    const outputs:readonly (readonly string[])[]=[['-c:a','pcm_f32le','-f','f32le'],['-c:a','pcm_s16le','-f','s16le'],['-ss','0.01','-t','0.04','-c:a','pcm_s16le','-f','s16le'],['-frames:a','2','-c:a','pcm_f32le','-bitexact','-f','framecrc'],['-c:a','pcm_s16le','-bitexact','-f','framecrc']];
    for(const [source,declared]of [['s16.raw',['-f','s16le','-ar','44100','-ac','2']],['f32.raw',['-f','f32le','-ar','48000','-ac','2']],['input.wav',[]]] as const)for(const chain of chains)for(const output of outputs){
      const before=['-cpuflags','0',...declared],after=['-af',chain,...output],expected=execFileSync(native,['-v','error',...before,'-i',join(root,source),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i',`/${source}`,...after,out]);
      expect(result.exitCode,JSON.stringify({source,chain,output,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).equals(expected),`${source}/${chain}/${output.join(' ')}`).toBe(true);
    }
    // A WAV output: header and samples.
    for(const chain of ['stereowiden','stereowiden=1:0:0.8:1']){
      const reference=join(root,`native-${index}.wav`),out=`/${index++}.wav`;
      execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(root,'input.wav'),'-af',chain,'-bitexact',reference]);
      const result=await frontend.exec(['-cpuflags','0','-i','/input.wav','-af',chain,'-bitexact',out]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(reference)),chain).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('fails explicitly before output for mono and masked input, native option errors and unimplemented forms',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-stereowiden-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*6));let index=0;
    const run=async(args:readonly string[],rate=8000,channels=2,input='input.raw',declared=true)=>{
      const before=['-cpuflags','0',...(declared?['-f','s16le','-ar',String(rate),'-ac',String(channels)]:[])],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${input}`,...args,'-f','framecrc',out]);
      return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,input),...args,'-f','framecrc','-']).status};
    };
    const refuse=async(label:string,nativeStatus:number|null,args:readonly string[],rate?:number,channels?:number,input?:string,declared?:boolean)=>{
      const outcome=await run(args,rate,channels,input,declared);
      expect(outcome.nativeStatus,label).toBe(nativeStatus);expect(outcome.result.exitCode,label).not.toBe(0);expect(outcome.result.diagnostics.at(-1)?.message,label).toMatch(/stereowiden/);expect(existsSync(join(root,outcome.out.slice(1))),label).toBe(false);
    };
    // Native rejects these too: out-of-range options (ERANGE), a positional value after a named one, too many positional values and a zero-length ring (EINVAL).
    for(const option of ['0.5','100.5','delay=0','feedback=0.91','crossfeed=0.81','drymix=1.01','crossfeed=-0.1','1k'])await refuse(option,222,['-af',`stereowiden=${option}`]);
    for(const option of ['delay=5:0.5','1:0.1:0.1:0.1:1'])await refuse(option,234,['-af',`stereowiden=${option}`]);
    // An unknown option fails with ENOENT.
    await refuse('foo',8,['-af','stereowiden=foo=1']);
    await refuse('zero-length ring',234,['-af','stereowiden=1'],500);
    // Native converts mono and three-channel input implicitly, and accepts timeline enable and expressions; all stay unimplemented.
    await refuse('mono',0,['-af','stereowiden'],8000,1);
    await refuse('three channels',0,['-af','stereowiden'],8000,3);
    await refuse('enable',0,['-af','stereowiden=enable=1']);
    await refuse('expression',0,['-af','stereowiden=2*3']);
    // Two-channel WAVs whose extensible masks are FL+FC (native: no remix matrix, fails) and DL+DR (native: treated as stereo, runs) are not the stereo layout.
    for(const [mask,nativeStatus]of [[0x5,234],[0x60000000,0]] as const){writeFileSync(join(root,`masked-${mask}.wav`),maskedWav(2,mask));await refuse(`mask 0x${mask.toString(16)}`,nativeStatus,['-af','stereowiden'],undefined,undefined,`masked-${mask}.wav`,false);}
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
