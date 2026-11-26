import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:262144,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000};
/** Deterministic sample bytes; f32le samples are finite values in [-1, 1). The LAF layout is written here, independent of the module. */
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};}
interface Shape {quality?:number;mode?:number;streams?:number;vertical?:number;horizontal?:number;lfe?:number;rate?:number;blocks?:number;tail?:number;mask?:number;seed?:number;duration?:bigint}
function laf({quality=1,mode=0,streams=1,vertical=0,horizontal=0,lfe=0,rate=8000,blocks=1,tail=0,mask=1,seed=1,duration=0n}:Shape):Uint8Array{
  const bpp=[1,2,4,3][quality]??1,header=19+9*streams+12,block=1+rate*bpp*streams,bytes=new Uint8Array(header+block*blocks+tail),view=new DataView(bytes.buffer),next=random(seed);
  bytes.set([...'LIMITLESSHEAD'].map(char=>char.charCodeAt(0)));bytes[13]=quality;bytes[14]=mode;view.setUint32(15,streams,true);
  for(let s=0;s<streams;s++){view.setFloat32(19+9*s,vertical,true);view.setFloat32(23+9*s,horizontal,true);bytes[27+9*s]=lfe;}
  view.setUint32(19+9*streams,rate,true);view.setBigUint64(23+9*streams,duration,true);
  for(let start=header;start<bytes.length;start+=block){
    bytes[start]=mask;
    for(let i=start+1;i<Math.min(start+block,bytes.length);i+=bpp)if(bpp===4&&i+4<=bytes.length)view.setFloat32(i,next()*2-1,true);else for(let k=0;k<bpp&&i+k<bytes.length;k++)bytes[i+k]=Math.floor(next()*256);
  }
  return bytes;
}
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(metadata.flags).toContain('--disable-x86asm');
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+laf\s/);
}
type Output=readonly [suffix:string,before:readonly string[],after:readonly string[]];
/** One native run per input writes every output (batched), then each output is compared byte for byte with the EdgeFFmpeg run. */
async function compare(root:string,ffmpeg:FFmpeg,name:string,outputs:readonly Output[]):Promise<number>{
  const before=outputs[0]![1];expect(outputs.every(output=>output[1].join(' ')===before.join(' '))).toBe(true);
  execFileSync(native,['-v','error','-y',...before,'-i',join(root,`${name}.laf`),...outputs.flatMap(([suffix,,after])=>[...after,join(root,`${name}.native.${suffix}`)])],{timeout:60000});
  for(const [suffix,,after] of outputs){
    const out=`/${name}.${suffix}`,run=await ffmpeg.exec([...before,'-i',`/${name}.laf`,...after,out]);
    expect(run.exitCode,`${name}/${suffix} ${JSON.stringify(run.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`${name}.native.${suffix}`))),`${name}/${suffix}`).toBe(true);
  }
  return outputs.length;
}
const raw=['u8','s16le','f32le','s24le'];
it('matches native LAF copy and decode framecrc, WAV and raw for four qualities at 8000 and 22050 Hz with 0 to 4 blocks and truncated tails',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-laf-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0,files=0;
    for(const quality of [0,1,2,3])for(const rate of [8000,22050]){
      const bpp=[1,2,4,3][quality]!;
      // Tails: none, a lone bitmask byte, a partial sample and all but one byte of the next block; native drops each (ffio_read_size).
      for(const [blocks,tail] of [[0,0],[1,0],[2,1],[3,1+bpp*5+1],[4,rate*bpp],[0,rate]] as const){
        const name=`q${quality}-r${rate}-b${blocks}-t${tail}`;writeFileSync(join(root,`${name}.laf`),laf({quality,rate,blocks,tail,seed:quality*7919+rate+blocks*31+tail}));files++;
        compared+=await compare(root,ffmpeg,name,[['copy.crc',['-cpuflags','0'],['-c:a','copy','-bitexact','-f','framecrc']],['decode.crc',['-cpuflags','0'],['-c:a','pcm_s16le','-bitexact','-f','framecrc']],['decode.wav',['-cpuflags','0'],['-bitexact','-f','wav']],['copy.raw',['-cpuflags','0'],['-c:a','copy','-f',raw[quality]!]],['s32.raw',['-cpuflags','0'],['-c:a','pcm_s32le','-f','s32le']]]);
      }
    }
    expect([files,compared]).toEqual([48,240]);
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native LAF channel layouts for FC, FL, FR, SL, SR, LFE, -0.0 and unmatched positions in WAV and raw, and refuses non-mono framecrc as before',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-laf-layout-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0,refused=0;
    const cases:Array<[string,Shape,string]>=[
      ['fc',{},'mono'],['fc-neg0',{vertical:-0,horizontal:-0},'mono'],['fl',{horizontal:-30},'1 channels (FL)'],['fr',{horizontal:30},'1 channels (FR)'],['sl',{vertical:-0,horizontal:-110},'1 channels (SL)'],['sr',{horizontal:110},'1 channels (SR)'],
      ['lfe',{lfe:1},'1 channels (LFE)'],['lfe-ff',{lfe:255,horizontal:-30},'1 channels (LFE)'],['other',{horizontal:12.5},'mono'],['raised',{vertical:1,horizontal:30},'mono'],['nan',{vertical:Number.NaN,horizontal:0},'mono'],['near',{horizontal:-30.000002},'mono']
    ];
    for(const [name,shape,layout] of cases){
      writeFileSync(join(root,`${name}.laf`),laf({...shape,blocks:2,tail:3,seed:name.length}));
      compared+=await compare(root,ffmpeg,name,[['wav',[],['-bitexact','-f','wav']],['copy.wav',[],['-c:a','copy','-bitexact','-f','wav']],['raw',[],['-f','s16le']],['u8.raw',[],['-c:a','pcm_u8','-f','u8']]]);
      const header=execFileSync(native,['-v','error','-i',join(root,`${name}.laf`),'-c:a','copy','-f','framecrc','-'],{encoding:'utf8'});
      expect(header,name).toContain(`#channel_layout_name 0: ${layout}\n`);
      if(layout==='mono'){compared+=await compare(root,ffmpeg,name,[['crc',[],['-c:a','copy','-bitexact','-f','framecrc']]]);continue;}
      // The PCM path names only the 12 standard masks for framecrc, so single-speaker layouts stay refused before any output.
      const run=await ffmpeg.exec(['-i',`/${name}.laf`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(run.exitCode,name).not.toBe(0);expect(run.diagnostics.at(-1)?.message,name).toBe('Unknown channel mask for framecrc output');expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);refused++;
    }
    expect([compared,refused]).toEqual([54,6]);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native LAF packet timing for output -ss, -t and -frames:a, declared -f laf and a header duration',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-laf-timing-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0;
    for(const quality of [0,1,3])for(const rate of [8000,22050]){
      const name=`t${quality}-${rate}`;writeFileSync(join(root,`${name}.laf`),laf({quality,rate,blocks:4,tail:17,seed:quality+rate,duration:BigInt(rate*2)}));
      const profiles:Array<[readonly string[],readonly string[]]>=[[[],['-ss','0.5','-t','1.7']],[[],['-t','0.0001']],[[],['-ss','1']],[[],['-frames:a','2']],[['-f','laf'],['-ss','3.9']],[['-f','laf'],['-t','9']],[[],['-ss','5']]];
      for(const [index,[declare,after]] of profiles.entries())
        compared+=await compare(root,ffmpeg,name,[[`${index}.copy.crc`,['-cpuflags','0',...declare],[...after,'-c:a','copy','-bitexact','-f','framecrc']],[`${index}.decode.crc`,['-cpuflags','0',...declare],[...after,'-af','volume=0.5:precision=fixed','-c:a','pcm_s16le','-bitexact','-f','framecrc']],[`${index}.wav`,['-cpuflags','0',...declare],[...after,'-bitexact','-f','wav']]]);
    }
    // -f laf reads past a wrong "LIMITLESS" (laf_read_header skips it) and so does EdgeFFmpeg. Undeclared, native falls back to the .laf
    // extension (0) or fails (183 for .bin); detection here is by content only, so both are refused.
    const odd=laf({blocks:2,seed:5});odd[0]=0x4e;writeFileSync(join(root,'odd.laf'),odd);
    compared+=await compare(root,ffmpeg,'odd',[['crc',['-f','laf'],['-c:a','copy','-bitexact','-f','framecrc']]]);
    for(const [file,status] of [['odd.laf',0],['odd.bin',183]] as const){
      writeFileSync(join(root,file),odd);
      expect(spawnSync(native,['-v','error','-y','-i',join(root,file),'-f','framecrc',join(root,`${file}.native.crc`)],{timeout:15000}).status,file).toBe(status);
      const undeclared=await ffmpeg.exec(['-i',`/${file}`,'-f','framecrc',`/${file}.crc`]);expect(undeclared.diagnostics.at(-1)?.message,file).toBe('Unsupported audio container signature');expect(existsSync(join(root,`${file}.crc`)),file).toBe(false);
    }
    expect(compared).toBe(127);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses malformed, multi-stream and seeking LAF before any output and records native exit statuses',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-laf-errors-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{...budget,maxBufferBytes:64}});
    const valid=laf({blocks:3,seed:9}),mid=valid.slice();mid[40+16001]=2;const tailMask=laf({blocks:2,tail:9,seed:3});tailMask[40+2*16001]=0;
    const truncated=laf({blocks:0}).subarray(0,39),rateMax=laf({quality:2,rate:536870911,blocks:0}),overflow=laf({quality:2,rate:536870912,blocks:0}),overflowU8=laf({quality:0,rate:2147483647,blocks:0});
    // Header failures are INVALIDDATA (183). Mid-stream failures (a zero bitmask) and native's selection among several streams exit 0 natively and are refused here.
    const cases:Array<[string,Uint8Array,readonly string[],number,string]>=[
      ['quality4',laf({quality:4,blocks:0}),[],183,'Invalid LAF quality: 4'],
      ['quality255',laf({quality:255,blocks:0}),['-f','laf'],183,'Invalid LAF quality: 255'],
      ['mode2',laf({mode:2}),[],183,'Invalid LAF mode: 2'],
      ['streams0',laf({streams:0,blocks:0}),[],183,'Invalid LAF stream count: 0'],
      ['streams4097',laf({blocks:0}).map((value,index)=>index===15?0x01:index===16?0x10:value),[],183,'Invalid LAF stream count: 4097'],
      ['streams2',laf({streams:2,mask:3}),[],0,'LAF files with 2 streams are not implemented'],
      ['streams3',laf({streams:3,mask:7}),[],0,'LAF files with 3 streams are not implemented'],
      ['rate0',laf({rate:0,blocks:0}),[],183,'Invalid LAF sample rate: 0'],
      ['overflow',overflow,[],183,'Invalid LAF sample rate: 536870912'],
      ['overflow-u8',overflowU8,[],183,'Invalid LAF sample rate: 2147483647'],
      ['truncated',truncated,['-f','laf'],183,'Truncated LAF header'],
      ['head',laf({}).map((value,index)=>index===12?0x45:value),['-f','laf'],183,'Invalid LAF header'],
      ['mask0-first',laf({mask:0}),[],0,'Invalid LAF stored bitmask at 40'],
      ['mask0-mid',mid,[],0,'Invalid LAF stored bitmask at 16041'],
      ['mask0-tail',tailMask,[],0,'Invalid LAF stored bitmask at 32042']
    ];
    const statuses:Record<string,number|null>={};
    for(const [name,bytes,declare,status,message] of cases){
      writeFileSync(join(root,`${name}.laf`),bytes);
      const nativeRun=spawnSync(native,['-v','error','-y',...declare,'-i',join(root,`${name}.laf`),'-c:a','copy','-f','framecrc',join(root,`${name}.native.crc`)],{timeout:30000});statuses[name]=nativeRun.status;
      expect(nativeRun.status,name).toBe(status);
      if(name.startsWith('mask0'))expect(nativeRun.stderr.toString(),name).toMatch(/Error during demuxing: Invalid data/);
      const result=await ffmpeg.exec([...declare,'-i',`/${name}.laf`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).toBe(status===183?183:1);expect(result.diagnostics.at(-1)?.message,name).toBe(message);expect(result.outputs).toEqual([]);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
    // The largest accepted f32le rate opens as an empty stream in both.
    writeFileSync(join(root,'ratemax.laf'),rateMax);
    expect(spawnSync(native,['-v','error','-y','-i',join(root,'ratemax.laf'),'-c:a','copy','-f','framecrc',join(root,'ratemax.native.crc')],{timeout:30000}).status).toBe(0);
    const max=await ffmpeg.exec(['-i','/ratemax.laf','-c:a','copy','-f','framecrc','/ratemax.crc']);expect(max.exitCode,JSON.stringify(max.diagnostics)).toBe(0);expect(readFileSync(join(root,'ratemax.crc')).equals(readFileSync(join(root,'ratemax.native.crc')))).toBe(true);
    // laf_read_seek returns -1 and the generic index takes over; input -ss is refused here.
    writeFileSync(join(root,'seek.laf'),laf({blocks:3,seed:4}));
    expect(spawnSync(native,['-v','error','-y','-ss','0.5','-i',join(root,'seek.laf'),'-c:a','copy','-f','framecrc',join(root,'seek.native.crc')],{timeout:15000}).status).toBe(0);
    const seek=await ffmpeg.exec(['-ss','0.5','-i','/seek.laf','-c:a','copy','-f','framecrc','/seek.crc']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','LAF input seeking is not implemented']);expect(existsSync(join(root,'seek.crc'))).toBe(false);
    // laf is demux-only in native and here.
    expect(spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'truncated.laf'),'-f','laf',join(root,'out.laf')],{timeout:15000}).status).not.toBe(0);
    const mux=await ffmpeg.exec(['-f','s16le','-i','/truncated.laf','-f','laf','/out.laf']);expect(mux.exitCode).not.toBe(0);expect(mux.diagnostics.at(-1)?.message).toMatch(/^Output requires /);expect(existsSync(join(root,'out.laf'))).toBe(false);
    expect(Object.keys(statuses)).toHaveLength(15);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
