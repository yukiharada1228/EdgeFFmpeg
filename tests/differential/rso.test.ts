import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openRso} from '../../packages/containers/src/rso.js';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:20000};
/** Native rso_write_trailer rewrites the size field only on a seekable output, so native always writes a file. */
function nativeFile(args:readonly string[],path:string):Buffer{execFileSync(native,['-v','error','-y',...args,path],{timeout:30000});return readFileSync(path);}
function checkReference(){
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  expect(execFileSync(native,['-v','error','-muxers'],{encoding:'utf8'})).toMatch(/E\s+rso\s/);expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+rso\s/);
}
function pattern(bytes:number,seed:number):Uint8Array{const data=new Uint8Array(bytes);for(let i=0;i<bytes;i++)data[i]=(i*131+seed*7+(i>>9))&255;return data;}
function header(tag:number,size:number,rate:number):Uint8Array{const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);view.setUint16(0,tag,false);view.setUint16(2,size,false);view.setUint16(4,rate,false);return bytes;}
it('matches native RSO mux bytes from raw u8 and WAV s16le inputs for three rates and six lengths',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rso-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});let compared=0;
    for(const rate of [8000,11025,65535])for(const length of [0,1,4097,65535,65536,70000]){
      const raw=pattern(length,rate),wide=new Uint8Array(length*2),view=new DataView(wide.buffer);for(let i=0;i<length;i++)view.setInt16(i*2,(i*3137+rate)%65536-32768,true);
      writeFileSync(join(root,'input.u8'),raw);writeFileSync(join(root,'input.s16'),wide);nativeFile(['-f','s16le','-ar',String(rate),'-ac','1','-i',join(root,'input.s16'),'-bitexact'],join(root,'input.wav'));
      for(const [label,input] of [['u8',['-f','u8','-ar',String(rate),'-ac','1','-i','input.u8']],['wav',['-i','input.wav']]] as const){
        const name=`${label}-${rate}-${length}`,nativeArgs=input.map(arg=>arg.startsWith('input.')?join(root,arg):arg),expected=nativeFile([...nativeArgs,'-bitexact'],join(root,`${name}-native.rso`));
        expect(expected.length).toBe(8+length);expect([...expected.subarray(0,8)]).toEqual([...header(0x0100,Math.min(length,0xffff),rate)]);
        const result=await ffmpeg.exec([...input.map(arg=>arg.startsWith('input.')?`/${arg}`:arg),'-bitexact',`/${name}.rso`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,`${name}.rso`)).equals(expected),name).toBe(true);compared++;
      }
    }
    expect(compared).toBe(36);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses RSO rates of 65536 and above stereo and pcm_s16le with native exit 183 before output creation',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rso-refuse-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    writeFileSync(join(root,'input.u8'),pattern(64,1));
    const cases:[string,string[],string[]][]=[['rate-65536',['-ar','65536','-ac','1'],[]],['rate-70000',['-ar','70000','-ac','1'],[]],['stereo',['-ar','8000','-ac','2'],[]],['s16le',['-ar','8000','-ac','1'],['-c:a','pcm_s16le']],['s16le-f',['-ar','8000','-ac','1'],['-c:a','pcm_s16le','-f','rso']]];
    for(const [name,declared,tail] of cases){
      const path=name==='s16le-f'?`${name}.dat`:`${name}.rso`,status=spawnSync(native,['-v','error','-y','-f','u8',...declared,'-i',join(root,'input.u8'),...tail,join(root,`native-${path}`)]).status;expect(status,name).toBe(183);
      const result=await ffmpeg.exec(['-f','u8',...declared,'-i','/input.u8',...tail,`/${path}`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(183);expect(existsSync(join(root,path)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native RSO demux of native-written and short or long header-size files through copy framecrc WAV decode and seeks',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rso-demux-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});let compared=0;
    const files:string[]=[];
    for(const [rate,length] of [[8000,4097],[11025,70000],[65535,1]] as const){writeFileSync(join(root,'input.u8'),pattern(length,rate));const name=`native-${rate}-${length}.rso`;nativeFile(['-f','u8','-ar',String(rate),'-ac','1','-i',join(root,'input.u8'),'-bitexact'],join(root,name));files.push(name);}
    for(const [size,length] of [[0,3000],[100,3000],[0xffff,3000],[3000,3000],[5000,4097]] as const){const name=`synthetic-${size}-${length}.rso`;writeFileSync(join(root,name),new Uint8Array([...header(0x0100,size,8000),...pattern(length,size)]));files.push(name);}
    const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.1'],[]],[['-ss','0.0125'],['-t','0.2']],[[],['-ss','0.05','-t','0.1']],[[],['-frames:a','2']]];
    for(const file of files){
      const info=(await openRso(await filesystem.openRead(`/${file}`),{maxReadBytes:3})).info;expect(info.durationSamples,file).toBe(BigInt(readFileSync(join(root,file)).length-8));
      for(const [index,[before,after]] of profiles.entries())for(const [mode,tail] of [['copy',['-c:a','copy','-f','framecrc']],['wav',['-f','wav']],['crc',['-c:a','pcm_s16le','-f','framecrc']]] as const){
        if(before.length&&Number(before[1])*info.sampleRate>=Number(info.durationSamples))continue;
        const declared=index%2?['-f','rso']:[],out=`${file}-${index}-${mode}.out`,expected=nativeFile(['-cpuflags','0',...before,...declared,'-i',join(root,file),...after,...tail,'-bitexact'],join(root,`native-${out}`));
        const result=await ffmpeg.exec(['-cpuflags','0',...before,...declared,'-i',`/${file}`,...after,...tail,'-bitexact',`/${out}`]);expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out)).equals(expected),out).toBe(true);compared++;
      }
    }
    expect(compared).toBe(114);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('detects undeclared RSO only by extension and refuses ADPCM and unknown tags with native exit 176',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rso-detect-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    const bytes=new Uint8Array([...header(0x0100,4,8000),...pattern(4000,3)]);writeFileSync(join(root,'input.rso'),bytes);writeFileSync(join(root,'input.dat'),bytes);
    const expected=execFileSync(native,['-v','error','-i',join(root,'input.rso'),'-f','s16le','-']),declared=execFileSync(native,['-v','error','-f','rso','-i',join(root,'input.dat'),'-f','s16le','-']);expect(declared.equals(expected)).toBe(true);
    for(const [args,out] of [[['-i','/input.rso'],'/a.raw'],[['-f','rso','-i','/input.dat'],'/b.raw']] as const){const result=await ffmpeg.exec([...args,'-f','s16le',out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected)).toBe(true);}
    expect(spawnSync(native,['-v','error','-i',join(root,'input.dat'),'-f','s16le','-']).status).not.toBe(0);
    const undetected=await ffmpeg.exec(['-i','/input.dat','-f','s16le','/c.raw']);expect(undetected.exitCode).not.toBe(0);expect(existsSync(join(root,'c.raw'))).toBe(false);
    for(const tag of [0x0101,0x0200,0]){
      const name=`tag-${tag}.rso`;writeFileSync(join(root,name),new Uint8Array([...header(tag,4,8000),1,2,3,4]));expect(spawnSync(native,['-v','error','-i',join(root,name),'-f','s16le','-']).status,name).toBe(176);
      const result=await ffmpeg.exec(['-i',`/${name}`,'-f','s16le',`/${name}.raw`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(176);expect(existsSync(join(root,`${name}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
