import {expect,it} from 'vitest';
import {execFile,execFileSync,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),run=promisify(execFile);
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:5000};
/** Deterministic u8 payload; the SIFF SOUN layout is written here, independent of the module. */
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};}
function siff(rate:number,bits:number,samples:number,seed:number,edit?:(bytes:Uint8Array,view:DataView)=>void):Uint8Array{
  const next=random(seed),bytes=new Uint8Array(36+samples),view=new DataView(bytes.buffer),ascii=(text:string,at:number)=>bytes.set([...text].map(c=>c.charCodeAt(0)),at);
  ascii('SIFF',0);view.setUint32(4,samples+28,false);ascii('SOUN',8);ascii('SHDR',12);view.setUint32(16,8,false);view.setUint32(20,0x1234,true);view.setUint16(24,rate,true);view.setUint16(26,bits,true);ascii('BODY',28);view.setUint32(32,samples,false);
  for(let i=0;i<samples;i++)bytes[36+i]=Math.floor(next()*256);
  edit?.(bytes,view);return bytes;
}
/** Native calls of one batch run concurrently, at most four at a time. */
async function natives(jobs:readonly {args:readonly string[];path:string}[]):Promise<Buffer[]>{
  const out:Buffer[]=new Array(jobs.length);let next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next<jobs.length){const index=next++,job=jobs[index]!;await run(native,['-v','error','-y',...job.args,job.path],{timeout:60000});out[index]=readFileSync(job.path);}}));
  return out;
}
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(metadata.flags).toContain('--disable-x86asm');
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+siff\s/);
}
async function edge(root:string,maxBufferBytes=budget.maxBufferBytes){const filesystem=await createNodeFileSystem({root,maxReadBytes:maxBufferBytes,maxWriteBytes:maxBufferBytes});return new FFmpeg({filesystem,backend:createMediaBackend(),budget:{...budget,maxBufferBytes}});}
const layouts=[[8000,8],[11025,8],[22050,8],[8000,16],[11025,16],[22050,16],[8000,24],[11025,32]] as const;
/** More than 65536 samples (past the 16-bit pts wrap), whole native packets of rate*(bits>>3) samples. */
const whole=(rate:number,bits:number)=>{const span=rate*(bits>>3);return Math.ceil(70000/span)*span;};
const outputs=[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['decode.crc',['-bitexact','-f','framecrc']],['decode.wav',['-bitexact','-f','wav']],['copy.u8',['-c:a','copy','-f','u8']],['decode.au',['-bitexact','-f','au']],['s16.raw',['-f','s16le']]] as const;
it('matches native SIFF copy framecrc, decode framecrc, WAV, raw u8, AU and s16le for eight rate and bit layouts with whole packets past 65536 samples',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-siff-'));
  try{
    const ffmpeg=await edge(root),jobs:{args:string[];path:string;out:string;name:string}[]=[];
    for(const [rate,bits] of layouts){
      const name=`r${rate}-b${bits}`;writeFileSync(join(root,`${name}.son`),siff(rate,bits,whole(rate,bits),rate+bits));
      for(const [suffix,after] of outputs)jobs.push({args:['-i',join(root,`${name}.son`),...after],path:join(root,`${name}.native.${suffix}`),out:`/${name}.${suffix}`,name});
    }
    const expected=await natives(jobs);let compared=0;
    for(const [index,job] of jobs.entries()){
      const result=await ffmpeg.exec(['-i',`/${job.name}.son`,...job.args.slice(2),job.out]);
      expect(result.exitCode,`${job.out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,job.out.slice(1))).equals(expected[index]!),job.out).toBe(true);compared++;
    }
    // Native rows: rate*(bits>>3) samples per packet and pts past 65536 unwrapped.
    const rows=expected[jobs.findIndex(job=>job.out==='/r22050-b8.copy.crc')]!.toString('latin1').split('\n').filter(line=>/^0,/.test(line));
    expect(rows.at(-1)).toMatch(/^0,\s+66150,\s+66150,\s+22050,\s+22050,/);expect(rows.some(row=>row.includes('F='))).toBe(false);
    expect(compared).toBe(48);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native SIFF decoding of short final packets and refuses their stream copy, which native flags F=0x3',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-siff-tail-'));
  try{
    const ffmpeg=await edge(root),jobs:{args:string[];path:string;out:string;name:string}[]=[],tails:string[]=[];
    for(const [rate,bits] of layouts)for(const extra of [1,4321]){
      const name=`t${rate}-b${bits}-${extra}`;writeFileSync(join(root,`${name}.son`),siff(rate,bits,whole(rate,bits)+extra,rate*bits+extra));tails.push(name);
      for(const [suffix,after] of outputs.filter(([suffix])=>!suffix.startsWith('copy')))jobs.push({args:['-i',join(root,`${name}.son`),...after],path:join(root,`${name}.native.${suffix}`),out:`/${name}.${suffix}`,name});
      jobs.push({args:['-i',join(root,`${name}.son`),'-c:a','copy','-f','framecrc'],path:join(root,`${name}.native.copy.crc`),out:'',name});
    }
    const expected=await natives(jobs);let compared=0,refused=0;
    for(const [index,job] of jobs.entries()){
      if(!job.out){
        expect(expected[index]!.toString('latin1').trimEnd().split('\n').at(-1),job.name).toMatch(/, F=0x3$/);
        const result=await ffmpeg.exec(['-i',`/${job.name}.son`,'-c:a','copy','-f','framecrc',`/${job.name}.copy.crc`]);
        expect([result.exitCode,result.diagnostics.at(-1)?.code,result.diagnostics.at(-1)?.message,existsSync(join(root,`${job.name}.copy.crc`))],job.name).toEqual([1,'unsupported-command','SIFF stream copy of a short final packet is not implemented',false]);refused++;continue;
      }
      const result=await ffmpeg.exec(['-i',`/${job.name}.son`,...job.args.slice(2),job.out]);
      expect(result.exitCode,`${job.out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,job.out.slice(1))).equals(expected[index]!),job.out).toBe(true);compared++;
    }
    expect([tails.length,compared,refused]).toEqual([16,64,16]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native SIFF packet timing for output -ss, -t and -frames:a, declared -f siff and filtered decode',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-siff-timing-'));
  try{
    // asetnsamples=n=700 holds 700 samples of reframed audio.
    const ffmpeg=await edge(root,4096),jobs:{args:string[];path:string;out:string;before:string[];after:string[];name:string}[]=[];
    const profiles=[['-t','1.5'],['-t','0.0001'],['-frames:a','2'],['-ss','1.25'],['-ss','0.5','-t','2.1'],['-ss','100'],['-frames:a','0']];
    for(const [rate,bits,extra] of [[8000,8,0],[11025,16,0],[22050,8,777]] as const){
      const name=`s${rate}-${bits}-${extra}`;writeFileSync(join(root,`${name}.son`),siff(rate,bits,whole(rate,bits)+extra,rate+bits+extra));
      for(const [index,profile] of profiles.entries())for(const declared of [false,true])for(const mode of ['copy','filtered','decode'] as const)for(const format of ['framecrc','wav'] as const){
        if(mode==='copy'&&(format==='wav'||extra))continue;
        if(declared&&mode!=='decode')continue;
        const before=declared?['-f','siff']:[],after=[...profile,...(mode==='copy'?['-c:a','copy']:mode==='filtered'?['-af','volume=0.5:precision=fixed,asetnsamples=n=700:p=0','-c:a','pcm_s16le']:[]),'-bitexact','-f',format];
        const out=`/${name}-${index}-${declared}-${mode}.${format}`;jobs.push({args:[...before,'-i',join(root,`${name}.son`),...after],path:join(root,'native'+out.slice(1)),out,before,after,name});
      }
    }
    const expected=await natives(jobs);let compared=0;
    for(const [index,job] of jobs.entries()){
      const result=await ffmpeg.exec([...job.before,'-i',`/${job.name}.son`,...job.after,job.out]);
      expect(result.exitCode,`${job.out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,job.out.slice(1))).equals(expected[index]!),job.out).toBe(true);compared++;
    }
    expect(compared).toBe(jobs.length);expect(compared).toBe(140);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses VBV1, malformed headers, empty-stream headers and input seeks before any output, with native statuses recorded',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-siff-errors-'));
  try{
    const ffmpeg=await edge(root),valid=siff(8000,8,8000,3);
    const ascii=(at:number,text:string)=>(bytes:Uint8Array)=>bytes.set([...text].map(c=>c.charCodeAt(0)),at);
    // Native statuses: read_header failures are AVERROR_INVALIDDATA (183) on every host; headers that open as an empty stream exit 0,
    // except rate 0, where the muxer's write_header fails with AVERROR(EINVAL): the host errno for native, refused here with status 1.
    const einval=256-constants.errno.EINVAL;
    const cases:Array<[string,Uint8Array,readonly string[],number,number,RegExp]>=[
      ['vbv1',siff(8000,8,8000,3,ascii(8,'VBV1')),[],183,1,/^SIFF VBV1 video is not implemented$/],
      ['shdr-size-9',siff(8000,8,8000,3,(_,view)=>view.setUint32(16,9,false)),[],183,183,/^Header chunk size is incorrect$/],
      ['shdr-size-le',siff(8000,8,8000,3,(_,view)=>view.setUint32(16,8,true)),[],183,183,/^Header chunk size is incorrect$/],
      ['shdr-missing',siff(8000,8,8000,3,ascii(12,'SHDX')),[],183,183,/^Header chunk is missing$/],
      ['body-missing',siff(8000,8,8000,3,ascii(28,'BODX')),[],183,183,/^'BODY' chunk is missing$/],
      ['header-20',valid.subarray(0,20),[],183,183,/^'BODY' chunk is missing$/],
      ['header-30',valid.subarray(0,30),[],183,183,/^'BODY' chunk is missing$/],
      ['kind-declared',siff(8000,8,8000,3,ascii(8,'SOUX')),['-f','siff'],183,183,/^Not a VBV file$/],
      ['magic-declared',siff(8000,8,8000,3,ascii(0,'SIFX')),['-f','siff'],183,183,/^Invalid SIFF header$/],
      ['header-33',valid.subarray(0,33),[],0,1,/^Truncated SIFF header$/],
      ['bits-7',siff(8000,7,8000,3),[],0,1,/^SIFF input with rate 8000 and 7 bits has no packets; not implemented$/],
      ['rate-0',siff(0,8,8000,3),[],einval,1,/^SIFF input with rate 0 and 8 bits has no packets; not implemented$/]
    ];
    const statuses:Record<string,number|null>={};
    for(const [name,bytes,declare,status,exit,message] of cases){
      writeFileSync(join(root,`${name}.son`),bytes);
      const nativeRun=spawnSync(native,['-v','error','-y',...declare,'-i',join(root,`${name}.son`),'-f','framecrc',join(root,`${name}.native.crc`)],{timeout:15000});statuses[name]=nativeRun.status;
      expect(nativeRun.status,name).toBe(status);
      const result=await ffmpeg.exec([...declare,'-i',`/${name}.son`,'-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).toBe(exit);expect(result.diagnostics.at(-1)?.message,name).toMatch(message);expect(result.outputs).toEqual([]);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
    // An undetected bad kind tag is not SIFF by content.
    writeFileSync(join(root,'kind.son'),siff(8000,8,8000,3,ascii(8,'SOUX')));
    const kind=await ffmpeg.exec(['-i','/kind.son','-f','framecrc','/kind.crc']);expect(kind.diagnostics.at(-1)?.message).toBe('Unsupported audio container signature');expect(existsSync(join(root,'kind.crc'))).toBe(false);
    // Native reads to EOF, logs a demux error there and exits 0; an empty BODY opens as an empty stream on both sides.
    writeFileSync(join(root,'valid.son'),valid);writeFileSync(join(root,'empty.son'),valid.subarray(0,36));
    const tail=spawnSync(native,['-v','error','-i',join(root,'valid.son'),'-f','framecrc','-'],{timeout:15000,encoding:'utf8'});expect(tail.status).toBe(0);expect(tail.stderr).toMatch(/Error during demuxing/);
    const [empty]=await natives([{args:['-i',join(root,'empty.son'),'-c:a','copy','-bitexact','-f','framecrc'],path:join(root,'empty.native.crc')}]);
    const emptyRun=await ffmpeg.exec(['-i','/empty.son','-c:a','copy','-bitexact','-f','framecrc','/empty.crc']);expect(emptyRun.exitCode).toBe(0);expect(readFileSync(join(root,'empty.crc')).equals(empty!)).toBe(true);
    // Input -ss goes through native's generic index; refused here.
    const seek=await ffmpeg.exec(['-ss','0.5','-i','/valid.son','-f','framecrc','/seek.crc']);expect(seek.exitCode).not.toBe(0);expect(seek.diagnostics.at(-1)?.message).toBe('SIFF input seeking is not implemented');expect(existsSync(join(root,'seek.crc'))).toBe(false);
    // siff is demux-only in native and here.
    expect(spawnSync(native,['-v','error','-y','-f','u8','-i',join(root,'valid.son'),'-f','siff',join(root,'out.son')],{timeout:15000}).status).not.toBe(0);
    const mux=await ffmpeg.exec(['-f','u8','-i','/valid.son','-f','siff','/out.son']);expect(mux.exitCode).not.toBe(0);expect(mux.diagnostics.at(-1)?.message).toMatch(/^Output requires /);expect(existsSync(join(root,'out.son'))).toBe(false);
    expect(Object.keys(statuses)).toHaveLength(12);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
