import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openSox} from '../../packages/containers/src/sox.js';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:1<<20,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:5000};
async function session(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128});return {root,filesystem,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget})};}
function nativeRun(args:readonly string[]){const result=spawnSync(native,['-nostdin','-v','error',...args],{maxBuffer:1<<26});return {status:result.status,stdout:result.stdout};}
const sources={s16le:2,s32le:4,f32le:4} as const;
function pcm(format:keyof typeof sources,samples:number){
  const bytes=new Uint8Array(samples*sources[format]),view=new DataView(bytes.buffer);
  for(let i=0;i<samples;i++){const value=(i*2654435761)%4294967296-2147483648;if(format==='s16le')view.setInt16(i*2,value>>16,true);else if(format==='s32le')view.setInt32(i*4,value,true);else view.setFloat32(i*4,(value/2147483648)*1.25,true);}
  return bytes;
}
// SoX header fields: magic, header_size, sample words, rate, channels (as written), comment size; then payload.
function header({magic='.SoX',headerSize=28,rate=8000,channels=2,comment=0,little=true,count=0n}:{magic?:string;headerSize?:number;rate?:number;channels?:number;comment?:number;little?:boolean;count?:bigint}={}){
  const bytes=new Uint8Array(32),view=new DataView(bytes.buffer);bytes.set([...magic].map(c=>c.charCodeAt(0)));view.setUint32(4,headerSize,little);view.setBigUint64(8,count,little);view.setFloat64(16,rate,little);view.setUint32(24,channels>>>0,little);view.setUint32(28,comment,little);return bytes;
}
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
it('writes SoX files byte-identical to native seekable output for both codecs, channel counts, rates, lengths and source formats',async()=>{
  const {root,ffmpeg}=await session('edgeffmpeg-sox-mux-');let compared=0;
  try{
    for(const format of Object.keys(sources) as Array<keyof typeof sources>)for(const channels of [1,2,3,6])for(const length of [0,1,67,4097]){
      writeFileSync(join(root,`${format}-${channels}-${length}.raw`),pcm(format,length*channels));
      for(const rate of [8000,44100,96000])for(const codec of ['pcm_s32le','pcm_s32be']){
        const name=`${format}-${channels}-${length}-${rate}-${codec}`,flags=format==='f32le'?['-cpuflags','0']:[],args=[...flags,'-f',format,'-ar',String(rate),'-ac',String(channels),'-i'],tail=codec==='pcm_s32le'?[]:['-c:a',codec];
        expect(nativeRun([...args,join(root,`${format}-${channels}-${length}.raw`),...tail,join(root,`${name}-native.sox`)]).status,name).toBe(0);
        const result=await ffmpeg.exec([...args,`/${format}-${channels}-${length}.raw`,...tail,`/${name}.sox`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,`${name}.sox`)).equals(readFileSync(join(root,`${name}-native.sox`))),name).toBe(true);compared++;
        rmSync(join(root,`${name}.sox`));rmSync(join(root,`${name}-native.sox`));
      }
    }
    expect(compared).toBe(288);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('demuxes native SoX files like native through copy framecrc, WAV, AIFF and raw decode, seeks, limits and volume',async()=>{
  const {root,filesystem,ffmpeg}=await session('edgeffmpeg-sox-demux-');let compared=0;
  try{
    for(const codec of ['pcm_s32le','pcm_s32be'])for(const channels of [1,2,3,6]){
      const name=`${codec}-${channels}`;writeFileSync(join(root,`${name}.raw`),pcm('s16le',4300*channels));
      expect(nativeRun(['-f','s16le','-ar','8000','-ac',String(channels),'-i',join(root,`${name}.raw`),'-c:a',codec,join(root,`${name}.sox`)]).status).toBe(0);
      expect((await openSox(await filesystem.openRead(`/${name}.sox`),{maxReadBytes:128})).info).toMatchObject({codec,channels,sampleRate:8000,durationSamples:4300n,dataOffset:32n,declaredSamples:BigInt(4300*channels)});
      const profiles:Array<{before:string[];after:string[];format:string}>=[
        {before:[],after:['-c:a','copy'],format:'framecrc'},{before:[],after:[],format:'framecrc'},
        {before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02','-c:a','copy'],format:'framecrc'},{before:['-ss','0.25'],after:['-t','0.1'],format:'framecrc'},
        {before:[],after:['-frames:a','2','-c:a','copy'],format:'framecrc'},{before:[],after:['-af','volume=0.5','-c:a','pcm_s32le'],format:'framecrc'},
        {before:['-guess_layout_max','0'],after:[],format:'framecrc'},{before:['-guess_layout_max','2'],after:['-c:a','copy'],format:'framecrc'},{before:[],after:[],format:'wav'},{before:[],after:[],format:'aiff'},{before:[],after:[],format:'s16le'},{before:['-ss','0.5'],after:['-af','volume=0.5'],format:'s16le'}];
      // For 3+ channels native AIFF writes a CHAN layout tag for the guessed layout, which the shared AIFF muxer does not (raw input diverges the same way).
      for(const [index,profile]of profiles.entries())for(const declared of [false,true]){
        if(profile.format==='aiff'&&channels>2)continue;
        const before=['-cpuflags','0',...profile.before,...(declared?['-f','sox']:[])],after=[...profile.after,'-bitexact','-f',profile.format],label=`${name}/${index}/${declared}`;
        const out=`/${name}-${index}-${declared}.out`;expect(nativeRun([...before,'-i',join(root,`${name}.sox`),...after,join(root,`native-${out.slice(1)}`)]).status,label).toBe(0);
        const result=await ffmpeg.exec([...before,'-i',`/${name}.sox`,...after,out]);expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`native-${out.slice(1)}`))),label).toBe(true);compared++;
      }
    }
    // Header padding (header_size 60) and a fractional rate, written by hand; native truncates 8000.75 to 8000.
    for(const [index,fields]of [{headerSize:60},{rate:8000.75},{little:false,magic:'XoS.',headerSize:124,rate:44100.5}].entries()){
      const little=fields.little??true,payload=new Uint8Array(4*2*33);new DataView(payload.buffer).setInt32(4,-123456789,little);for(let i=8;i<payload.length;i++)payload[i]=(i*37)&255;
      const file=concat(header({...fields,little}),new Uint8Array((fields.headerSize??28)-28),payload);writeFileSync(join(root,`hand-${index}.sox`),file);
      for(const format of ['framecrc','s16le']){
        const expected=nativeRun(['-i',join(root,`hand-${index}.sox`),'-bitexact','-f',format,'-']);expect(expected.status).toBe(0);
        const result=await ffmpeg.exec(['-i',`/hand-${index}.sox`,'-bitexact','-f',format,`/hand-${index}.${format}`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,`hand-${index}.${format}`)).equals(expected.stdout),`hand ${index} ${format}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(2*(2*12+2*11)*2+6);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native exit codes for malformed SoX headers and refuses unmirrored ones before output',async()=>{
  const {root,ffmpeg}=await session('edgeffmpeg-sox-malformed-');
  try{
    const data=new Uint8Array(64);
    const invalid:Record<string,Uint8Array>={
      alignment:concat(header({headerSize:32}),new Uint8Array(4),data),undersized:concat(header({headerSize:20}),data),channels0:concat(header({channels:0}),data),channels65536:concat(header({channels:65536}),data),channelsNegative:concat(header({channels:-2}),data),
      nan:concat(header({rate:Number.NaN}),data),negative:concat(header({rate:-8000}),data),zero:concat(header({rate:0}),data),infinite:concat(header({rate:Infinity}),data),aboveIntMax:concat(header({rate:2147483648}),data),
      commentOverflow:concat(header({comment:0xffffffe0}),data),commentBeyondHeader:concat(header({comment:8}),data),bigEndianAlignment:concat(header({magic:'XoS.',little:false,headerSize:32}),new Uint8Array(4),data)};
    for(const [name,bytes]of Object.entries(invalid))for(const declared of [false,true]){
      writeFileSync(join(root,`${name}.sox`),bytes);const args=[...(declared?['-f','sox']:[]),'-i'];
      const expected=nativeRun([...args,join(root,`${name}.sox`),'-f','s16le',join(root,`${name}-native.raw`)]);
      const result=await ffmpeg.exec([...args,`/${name}.sox`,'-f','s16le',`/${name}.raw`]);
      // Undeclared headers that fail sox_probe (zero channel word) are undetected natively (183) and here (no signature: exit 1).
      if(!declared&&name==='channels0'){expect(expected.status).toBe(183);expect([result.exitCode,result.diagnostics.at(-1)?.message]).toEqual([1,'Unsupported audio container signature']);}
      else expect([result.exitCode,result.diagnostics.at(-1)?.code],`${name} ${declared}`).toEqual([expected.status,'unsupported-command']);
      expect(expected.status,name).not.toBe(0);expect(existsSync(join(root,`${name}.raw`)),name).toBe(false);
    }
    // Native-accepted inputs whose semantics are not mirrored: a comment (exported as metadata), a sub-1 Hz rate, a truncated or overlong header, a partial frame.
    const refused:Record<string,{bytes:Uint8Array;status:number;message:RegExp}>={
      comment:{bytes:concat(header({headerSize:36,comment:8}),new TextEncoder().encode('hello\0\0\0'),data),status:0,message:/comment metadata is not implemented/},
      halfHertz:{bytes:concat(header({rate:0.5}),data),status:234,message:/below 1 Hz/},
      truncated:{bytes:header().subarray(0,30),status:0,message:/Truncated SoX header/},
      overlong:{bytes:concat(header({headerSize:124}),data.subarray(0,32)),status:0,message:/header exceeds input/},
      partialFrame:{bytes:concat(header(),data.subarray(0,12)),status:0,message:/Incomplete raw PCM sample frame/}};
    for(const [name,{bytes,status,message}]of Object.entries(refused)){
      writeFileSync(join(root,`${name}.sox`),bytes);
      expect(nativeRun(['-f','sox','-i',join(root,`${name}.sox`),'-f','s16le',join(root,`${name}-native.raw`)]).status,name).toBe(status);
      const result=await ffmpeg.exec(['-f','sox','-i',`/${name}.sox`,'-f','s16le',`/${name}.raw`]);expect(result.exitCode,name).toBe(status||1);expect(result.diagnostics.at(-1)?.message,name).toMatch(message);expect(existsSync(join(root,`${name}.raw`)),name).toBe(false);
    }
    // Muxer codec refusal: native EINVAL from sox_write_header; here before the output exists.
    writeFileSync(join(root,'in.raw'),pcm('s16le',64));
    for(const codec of ['pcm_s16le','pcm_f32le','pcm_s24le','pcm_u8']){
      const expected=nativeRun(['-f','s16le','-ar','8000','-i',join(root,'in.raw'),'-c:a',codec,'-f','sox',join(root,`${codec}-native.sox`)]);expect(expected.status,codec).toBe(234);
      const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-i','/in.raw','-c:a',codec,`/${codec}.sox`]);expect([result.exitCode,result.diagnostics.at(-1)?.code],codec).toEqual([234,'unsupported-command']);expect(existsSync(join(root,`${codec}.sox`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('reproduces the FATE lavf-sox reference file and its decode',async()=>{
  const {root,ffmpeg}=await session('edgeffmpeg-sox-fate-');
  try{
    execFileSync('cc',['-O2','-o',join(root,'audiogen'),resolve('upstream/ffmpeg/tests/audiogen.c'),'-lm']);execFileSync(join(root,'audiogen'),[join(root,'asynth1.sw')]);
    // fate-lavf-sox: lavf_audio with -ar 44100 -f s16le -i asynth1.sw ... -t 1; -metadata title is not a comment and does not reach the SoX header.
    const result=await ffmpeg.exec(['-ar','44100','-f','s16le','-i','/asynth1.sw','-t','1','/lavf.sox']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
    const bytes=readFileSync(join(root,'lavf.sox'));expect([createHash('md5').update(bytes).digest('hex'),bytes.length]).toEqual(['683635d5cb1344e44fa96df90c3a993c',176432]);
    expect(nativeRun(['-auto_conversion_filters','-ar','44100','-f','s16le','-i',join(root,'asynth1.sw'),'-threads','1','-metadata','title=lavftest','-t','1','-qscale','10',join(root,'native.sox')]).status).toBe(0);expect(readFileSync(join(root,'native.sox')).equals(bytes)).toBe(true);
    expect(nativeRun(['-i',join(root,'lavf.sox'),'-f','crc','-']).stdout.toString()).toBe('CRC=0x3a1da17e\n');
    const expected=nativeRun(['-i',join(root,'lavf.sox'),'-c:a','copy','-bitexact','-f','framecrc','-']),decoded=await ffmpeg.exec(['-i','/lavf.sox','-c:a','copy','-bitexact','-f','framecrc','/lavf.crc']);
    expect(decoded.exitCode,JSON.stringify(decoded.diagnostics)).toBe(0);expect(readFileSync(join(root,'lavf.crc')).equals(expected.stdout)).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
