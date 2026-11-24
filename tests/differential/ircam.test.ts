import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const codecs=['pcm_alaw','pcm_mulaw','pcm_s8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'];
const tags:Record<string,number>={pcm_alaw:0x10001,pcm_mulaw:0x20001,pcm_s8:1,pcm_s16le:2,pcm_s24le:3,pcm_s32le:0x40004,pcm_f32le:4,pcm_f64le:8};
const raw:Record<string,string>={pcm_alaw:'alaw',pcm_mulaw:'mulaw',pcm_s8:'s8',pcm_s16le:'s16le',pcm_s24le:'s24le',pcm_s32le:'s32le',pcm_f32le:'f32le',pcm_f64le:'f64le',pcm_s16be:'s16be',pcm_s24be:'s24be',pcm_s32be:'s32be',pcm_f32be:'f32be',pcm_f64be:'f64be'};
const magics:Array<[number,boolean]>=[[0x64a30100,false],[0x64a30200,true],[0x64a30300,false],[0x64a30400,true],[0x0001a364,true],[0x0002a364,false],[0x0003a364,true]];
const float=(value:number)=>{const view=new DataView(new ArrayBuffer(4));view.setFloat32(0,value,true);return view.getUint32(0,true);};
function header(magic:number,le:boolean,rateBits:number,channels:number,tag:number,payload:Uint8Array){
  const bytes=new Uint8Array(1024+payload.length),view=new DataView(bytes.buffer);
  view.setUint32(0,magic,true);view.setUint32(4,rateBits,le);view.setUint32(8,channels,le);view.setUint32(12,tag,le);bytes.set(payload,1024);return bytes;
}
function payload(bytes:number){const data=new Uint8Array(bytes);for(let i=0;i<bytes;i++)data[i]=(i*151+(i>>3)*17)&255;return data;}
const floatSafe=(codec:string,data:Uint8Array)=>{
  // Finite, moderate float samples so decode paths never meet NaN payloads.
  if(!codec.startsWith('pcm_f'))return data;
  const width=codec.includes('32')?4:8,le=!codec.endsWith('be'),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  for(let i=0;i+width<=data.length;i+=width){const value=Math.sin(i*0.37)*0.9;if(width===4)view.setFloat32(i,value,le);else view.setFloat64(i,value,le);}
  return data;
};
async function harness(prefix:string){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}});
  return {root,ffmpeg};
}
it('matches native IRCAM mux bytes for 8 codecs x 3 layouts x 5 rates x 4 lengths and decodes them back',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-mux-');let compared=0;
  try{
    for(const channels of [1,2,5])for(const samples of [0,1,67,4097]){
      const input=new Uint8Array(samples*channels*2),view=new DataView(input.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),input);
      for(const rate of [8000,22050,44100,96000,16777217])for(const codec of codecs){
        const name=`${codec}-${rate}-${channels}-${samples}`,args=['-f','s16le','-ar',String(rate),'-ac',String(channels),'-i'],tail=['-c:a',codec,'-bitexact'];
        execFileSync(native,['-v','error',...args,join(root,'input.raw'),...tail,'-f','ircam',join(root,`${name}-native.sf`)]);
        const result=await ffmpeg.exec([...args,'/input.raw',...tail,`/${name}.sf`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,`${name}.sf`)).equals(readFileSync(join(root,`${name}-native.sf`))),name).toBe(true);compared++;
        if(samples!==67||rate===16777217)continue;
        const back=await ffmpeg.exec(['-i',`/${name}-native.sf`,'-c:a','copy','-f',raw[codec]!,`/${name}.raw`]);expect(back.exitCode,`${name} ${JSON.stringify(back.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,`${name}.raw`)).equals(execFileSync(native,['-v','error','-i',join(root,`${name}-native.sf`),'-c:a','copy','-f',raw[codec]!,'-']))).toBe(true);compared++;
      }
    }
    expect(compared).toBe(480+96);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native IRCAM demux for all seven magics and both tag tables through copy framecrc, WAV decode and raw output',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-demux-');let compared=0;
  try{
    for(const [magic,le]of magics)for(const codec of codecs)for(const channels of [1,2,5]){
      const decoded=le||['pcm_alaw','pcm_mulaw','pcm_s8'].includes(codec)?codec:codec.replace(/le$/,'be'),width=({pcm_s16le:2,pcm_s24le:3,pcm_s32le:4,pcm_f32le:4,pcm_f64le:8} as Record<string,number>)[codec]??1;
      const name=`${magic.toString(16)}-${codec}-${channels}`,file=`${name}.sf`;
      writeFileSync(join(root,file),header(magic,le,float(11025),channels,tags[codec]!,floatSafe(decoded,payload(width*channels*1500))));
      const force=magic===0x64a30400?['-f','ircam']:[],crc=['-cpuflags','0',...force,'-i','-c:a','copy','-bitexact','-f','framecrc'],at=crc.indexOf('-i')+1;
      const expectedCrc=execFileSync(native,['-v','error',...crc.slice(0,at),join(root,file),...crc.slice(at),'-']);
      const edgeCrc=await ffmpeg.exec([...crc.slice(0,at),`/${file}`,...crc.slice(at),`/${name}.crc`]);expect(edgeCrc.exitCode,`${name} ${JSON.stringify(edgeCrc.diagnostics)}`).toBe(0);
      expect(readFileSync(join(root,`${name}.crc`)).toString()).toBe(expectedCrc.toString());expect(expectedCrc.toString()).toContain(`#codec_id 0: ${decoded}`);compared++;
      const wav=await ffmpeg.exec(['-cpuflags','0',...force,'-i',`/${file}`,'-bitexact',`/${name}.wav`]);expect(wav.exitCode,`${name} ${JSON.stringify(wav.diagnostics)}`).toBe(0);
      execFileSync(native,['-v','error','-cpuflags','0',...force,'-i',join(root,file),'-bitexact',join(root,`${name}-native.wav`)]);
      expect(readFileSync(join(root,`${name}.wav`)).equals(readFileSync(join(root,`${name}-native.wav`))),name).toBe(true);compared++;
      const out=await ffmpeg.exec([...force,'-i',`/${file}`,'-c:a','copy','-f',raw[decoded]!,`/${name}.raw`]);expect(out.exitCode).toBe(0);
      expect(readFileSync(join(root,`${name}.raw`)).equals(execFileSync(native,['-v','error',...force,'-i',join(root,file),'-c:a','copy','-f',raw[decoded]!,'-']))).toBe(true);compared++;
    }
    // Probed heads detect without an extension; 0x64A30400 has no probe head and is refused undeclared (native: 183 for .bin).
    for(const [magic,le]of magics){
      const name=`${magic.toString(16)}-bin`;writeFileSync(join(root,`${name}.bin`),header(magic,le,float(8000),1,2,payload(200)));
      const expected=spawnSync(native,['-v','error','-i',join(root,`${name}.bin`),'-c:a','copy','-f','framecrc','-']),result=await ffmpeg.exec(['-i',`/${name}.bin`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(magic===0x64a30400?183:0).toBe(expected.status);
      if(expected.status===0)expect(readFileSync(join(root,`${name}.crc`)).equals(expected.stdout)).toBe(true);else{expect(result.exitCode).not.toBe(0);expect(existsSync(join(root,`${name}.crc`))).toBe(false);}
      const forced=await ffmpeg.exec(['-f','ircam','-i',`/${name}.bin`,'-c:a','copy','-f','framecrc',`/${name}-forced.crc`]);expect(forced.exitCode).toBe(0);
      expect(readFileSync(join(root,`${name}-forced.crc`)).equals(execFileSync(native,['-v','error','-f','ircam','-i',join(root,`${name}.bin`),'-c:a','copy','-f','framecrc','-']))).toBe(true);compared+=2;
    }
    expect(compared).toBe(7*8*3*3+14);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native IRCAM packet timing through copy and filtered framecrc with seeks, durations and frame limits',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-timing-');let compared=0;
  try{
    const source=new Uint8Array(4300*4),view=new DataView(source.buffer);for(let i=0;i<8600;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),source);
    for(const codec of ['pcm_s16le','pcm_s24le','pcm_f64le','pcm_mulaw']){
      const path=join(root,`${codec}.sf`);execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact',path]);
      const profiles=[{before:[],after:[]},{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:[],after:['-frames:a','2']},{before:['-ss','0.25'],after:[]}];
      for(const [index,profile]of profiles.entries())for(const copy of [true,false]){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=11025','-c:a','pcm_s16le']),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',path,...after,'-']),out=`/${codec}-${index}-${copy}.crc`,result=await ffmpeg.exec([...before,'-i',`/${codec}.sf`,...after,out]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${codec}/${index}/${copy}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(32);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches the native lrintf IRCAM float sample rate on ties and fractions',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-rate-');
  try{
    const rates=[22050.5,22051.5,8000.5,8001.5,44099.5,44100.5,1.5,2.5,3.5,0.75,7999.25,7999.75,11025.4990234375,11025.5009765625,96000.5,16777215,16777216,33554436,2147483520,Math.fround(48000.1),Math.fround(Math.PI*1000)];
    for(const [index,rate]of rates.entries())for(const [magic,le]of [[0x0001a364,true],[0x64a30100,false]] as const){
      const file=`rate-${index}-${magic.toString(16)}.sf`;writeFileSync(join(root,file),header(magic,le,float(rate),1,2,payload(64)));
      const expected=execFileSync(native,['-v','error','-i',join(root,file),'-c:a','copy','-f','framecrc','-']).toString(),result=await ffmpeg.exec(['-i',`/${file}`,'-c:a','copy','-f','framecrc',`/${file}.crc`]);
      expect(result.exitCode,`${rate} ${JSON.stringify(result.diagnostics)}`).toBe(0);
      const actual=readFileSync(join(root,`${file}.crc`)).toString();expect(actual.match(/#sample_rate 0: (\d+)/)?.[1],String(rate)).toBe(expected.match(/#sample_rate 0: (\d+)/)?.[1]);expect(actual).toBe(expected);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses IRCAM inputs and outputs with the native exit status before any output exists',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-refusal-');
  try{
    const cases:Array<[string,Uint8Array]>=[['tag',header(0x0001a364,true,float(8000),1,5,payload(8))],['tag-be',header(0x64a30100,false,float(8000),1,0x40005,payload(8))],['channels0',header(0x0001a364,true,float(8000),0,2,payload(8))],['channels513',header(0x0001a364,true,float(8000),513,2,payload(8))],['rate0',header(0x0001a364,true,float(0.5),1,2,payload(8))],['rate-zero',header(0x0002a364,false,0,1,2,payload(8))],['magic',header(0x0004a364,true,float(8000),1,2,payload(8))],['short',new Uint8Array([0x64,0xa3,1,0,0,0,0xfa,0x45])]];
    for(const [name,bytes]of cases){
      writeFileSync(join(root,`${name}.sf`),bytes);
      const expected=spawnSync(native,['-v','error','-i',join(root,`${name}.sf`),'-f','framecrc','-']),result=await ffmpeg.exec(['-i',`/${name}.sf`,'-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).not.toBe(0);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(expected.status);expect(existsSync(join(root,`${name}.crc`))).toBe(false);
    }
    writeFileSync(join(root,'input.raw'),payload(64));
    for(const codec of ['pcm_s16be','pcm_u8','pcm_u16le','pcm_f32be','pcm_s24be','pcm_s32be','pcm_f64be']){
      const args=['-f','s16le','-ar','8000','-ac','1','-i'],tail=['-c:a',codec,'-f','ircam'];
      const expected=spawnSync(native,['-v','error','-y',...args,join(root,'input.raw'),...tail,join(root,`${codec}-native.sf`)]),result=await ffmpeg.exec([...args,'/input.raw',...tail,`/${codec}.sf`]);
      expect(expected.status).toBe(234);expect(result.exitCode,codec).toBe(234);expect(result.diagnostics.at(-1)?.message).toBe(`IRCAM muxer does not support ${codec}`);expect(existsSync(join(root,`${codec}.sf`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches the FATE lavf-ircam reference exactly',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-ircam-fate-');
  try{
    // tests/fate-run.sh lavf_audio: -ar 44100 -f s16le -i asynth1.sw -metadata title=lavftest -t 1 -qscale 10 out.ircam, then -f crc of its decode.
    // The ircam muxer writes no metadata and -qscale has no PCM effect, so both are dropped; native's md5 is the same without them (checked below).
    execFileSync('cc',['-O2',resolve('upstream/ffmpeg/tests/audiogen.c'),'-o',join(root,'audiogen')]);execFileSync(join(root,'audiogen'),[join(root,'asynth1.sw')]);
    const reference=readFileSync(resolve('upstream/ffmpeg/tests/ref/lavf/ircam'),'utf8').split('\n'),md5=reference[0]!.split(' ')[0],size=Number(reference[1]!.split(' ')[0]),crc=reference[2]!.split('CRC=')[1];
    const result=await ffmpeg.exec(['-ar','44100','-f','s16le','-i','/asynth1.sw','-t','1','-bitexact','/lavf.ircam']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
    const bytes=readFileSync(join(root,'lavf.ircam'));expect(bytes.length).toBe(size);expect(createHash('md5').update(bytes).digest('hex')).toBe(md5);
    execFileSync(native,['-v','error','-auto_conversion_filters','-ar','44100','-f','s16le','-i',join(root,'asynth1.sw'),'-metadata','title=lavftest','-t','1','-qscale','10','-bitexact',join(root,'native.ircam')]);expect(createHash('md5').update(readFileSync(join(root,'native.ircam'))).digest('hex')).toBe(md5);
    const decoded=await ffmpeg.exec(['-i','/lavf.ircam','-f','s16le','/lavf.raw']);expect(decoded.exitCode).toBe(0);
    let a=1,b=0;for(const byte of readFileSync(join(root,'lavf.raw'))){a=(a+byte)%65521;b=(b+a)%65521;}
    expect(`0x${((b<<16|a)>>>0).toString(16).padStart(8,'0')}`).toBe(crc);
  }finally{rmSync(root,{recursive:true,force:true});}
});
