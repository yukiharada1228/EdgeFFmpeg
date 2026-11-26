import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
// Native runs at test time against the sandbox or CI reference build; only its commit and flags are pinned, never a binary digest.
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
const latin=(text:string)=>Uint8Array.from(text,character=>character.charCodeAt(0));
const cat=(...parts:Uint8Array[])=>{const result=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;};
function chunk(id:string,data:Uint8Array,pad=true){const bytes=new Uint8Array(8+data.length+(pad?data.length&1:0));bytes.set(latin(id));new DataView(bytes.buffer).setUint32(4,data.length,false);bytes.set(data,8);return bytes;}
function mhdr({bits=8,num=8000,den=1,channels=1,compression=0,size=32}:{bits?:number;num?:number;den?:number;channels?:number;compression?:number;size?:number}={}){
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  if(size>=20){view.setUint16(4,bits,false);view.setUint32(8,num,false);view.setUint16(12,den,false);view.setUint16(16,channels,false);view.setUint16(18,compression,false);}
  return bytes;
}
function form(type:string,...chunks:Uint8Array[]){const body=cat(latin(type),...chunks),head=new Uint8Array(8);head.set(latin('FORM'));new DataView(head.buffer).setUint32(4,body.length,false);return cat(head,body);}
const payload=(length:number,seed=0)=>Uint8Array.from({length},(_,index)=>(index*151+(index>>3)*17+seed*29)&255);
const chan=(value:number)=>{const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,false);return chunk('CHAN',bytes);};
const codecs=[{codec:'pcm_u8',bits:8,compression:0,raw:'u8'},{codec:'pcm_s16be',bits:16,compression:0,raw:'s16be'},{codec:'pcm_alaw',bits:8,compression:2,raw:'alaw'},{codec:'pcm_mulaw',bits:8,compression:3,raw:'mulaw'}] as const;
async function harness(prefix:string){
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<22,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:20000}});
  return {root,ffmpeg};
}
it('matches native IFF MAUD demux for 4 codecs x 3 layouts through copy and decoded framecrc, WAV and raw output',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-iff-demux-');let compared=0;
  try{
    for(const {codec,bits,compression,raw}of codecs)for(const channels of [1,2,3])for(const variant of ['plain','fraction','trailing','chan'] as const){
      // 2 full 8192-sample packets plus a short one; rates 22050/1, 44100/3 (14700) and 32000/7 (4571, truncated); chunks after MDAT; CHAN override.
      const samples=8192*2+77,frame=bits/8*channels,rate=variant==='fraction'?{num:44100,den:3}:variant==='trailing'?{num:32000,den:7}:{num:22050,den:1};
      const chunks=[chunk('MHDR',mhdr({bits,compression,channels:variant==='chan'?3:channels,...rate})),...(variant==='chan'?[chan(channels===1?2:6)]:[]),chunk('XTRA',payload(7)),chunk('MDAT',payload(samples*(variant==='chan'?bits/8*(channels===1?1:2):frame),channels)),...(variant==='trailing'?[chunk('ZZZZ',payload(9))]:[])];
      const name=`${codec}-${channels}-${variant}`,file=`${name}.maud`;writeFileSync(join(root,file),form('MAUD',...chunks));
      const decodedChannels=variant==='chan'?(channels===1?1:2):channels;
      for(const copy of [true,false]){
        const tail=[...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error','-i',join(root,file),...tail,'-']).toString();
        const result=await ffmpeg.exec(['-i',`/${file}`,...tail,`/${name}-${copy}.crc`]);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,`${name}-${copy}.crc`)).toString(),`${name}/${copy}`).toBe(expected);compared++;
        if(copy){expect(expected).toContain(`#codec_id 0: ${codec}`);expect(expected.split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',')[3]!.trim())).toEqual(['8192','8192','77']);}
      }
      const wav=await ffmpeg.exec(['-i',`/${file}`,'-bitexact',`/${name}.wav`]);expect(wav.exitCode,`${name} ${JSON.stringify(wav.diagnostics)}`).toBe(0);
      execFileSync(native,['-v','error','-i',join(root,file),'-bitexact',join(root,`${name}-native.wav`)]);
      expect(readFileSync(join(root,`${name}.wav`)).equals(readFileSync(join(root,`${name}-native.wav`))),name).toBe(true);compared++;
      const out=await ffmpeg.exec(['-i',`/${file}`,'-c:a','copy','-f',raw,`/${name}.raw`]);expect(out.exitCode).toBe(0);
      const expectedRaw=execFileSync(native,['-v','error','-i',join(root,file),'-c:a','copy','-f',raw,'-']);expect(expectedRaw.length).toBe(samples*bits/8*decodedChannels);
      expect(readFileSync(join(root,`${name}.raw`)).equals(expectedRaw),name).toBe(true);compared++;
    }
    expect(compared).toBe(4*3*4*4);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native IFF MAUD timing with output seeks, durations and frame limits, detected without -f or an extension',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-iff-timing-');let compared=0;
  try{
    for(const {codec,bits,compression}of [codecs[0],codecs[1]]){
      const file=`${codec}.bin`;writeFileSync(join(root,file),form('MAUD',chunk('MHDR',mhdr({bits,compression,channels:2,num:16000,den:1})),chunk('MDAT',payload(20000*bits/8*2))));
      const profiles=[[],['-ss','0.6','-t','0.4'],['-t','0.55'],['-ss','1.1'],['-frames:a','2']];
      for(const [index,profile]of profiles.entries())for(const copy of [true,false])for(const forced of [false,true]){
        const before=forced?['-f','iff']:[],after=[...profile,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed','-c:a','pcm_s16le']),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,file),...after,'-']),out=`/${codec}-${index}-${copy}-${forced}.crc`,result=await ffmpeg.exec([...before,'-i',`/${file}`,...after,out]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).toString(),`${codec}/${index}/${copy}/${forced}`).toBe(expected.toString());compared++;
      }
    }
    expect(compared).toBe(2*5*2*2);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses IFF NAME metadata for WAV and AIFF output and matches native raw, framecrc and W64 output',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-iff-metadata-');let compared=0;
  try{
    for(const id of ['NAME','ANNO','AUTH']){
      const file=`${id}.maud`;writeFileSync(join(root,file),form('MAUD',chunk('MHDR',mhdr({bits:16,channels:2})),chunk(id,latin('lavf test')),chunk('MDAT',payload(4*900))));
      for(const output of ['out.wav','out.aiff']){
        expect(spawnSync(native,['-v','error','-y','-i',join(root,file),'-bitexact',join(root,`native-${output}`)]).status).toBe(0);
        const result=await ffmpeg.exec(['-i',`/${file}`,'-bitexact',`/${id}-${output}`]);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toContain('Input metadata');
        expect(existsSync(join(root,`${id}-${output}`))).toBe(false);compared++;
      }
      for(const [format,args]of [['s16be',['-c:a','copy','-f','s16be']],['framecrc',['-c:a','copy','-bitexact','-f','framecrc']],['w64',['-bitexact','-f','w64']]] as const){
        const out=`${id}.${format}`,result=await ffmpeg.exec(['-i',`/${file}`,...args,`/${out}`]);expect(result.exitCode,`${id}/${format} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        execFileSync(native,['-v','error','-i',join(root,file),...args,join(root,`native-${out}`)]);expect(readFileSync(join(root,out)).equals(readFileSync(join(root,`native-${out}`))),`${id}/${format}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(3*5);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses IFF inputs with the native exit status or explicitly before any output exists',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-iff-refusal-');
  try{
    const valid=[chunk('MHDR',mhdr()),chunk('MDAT',payload(100))],vhdr=(compression:number)=>{const bytes=new Uint8Array(20),view=new DataView(bytes.buffer);view.setUint16(12,8000,false);bytes[15]=compression;return chunk('VHDR',bytes);};
    const truncated=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(100)));
    // [name, bytes, native status (null: native succeeds and EdgeFFmpeg refuses), input args]
    const cases:Array<[string,Uint8Array,number|null,string[]]>=[
      ['compression4',form('MAUD',chunk('MHDR',mhdr({compression:4})),chunk('MDAT',payload(100))),176,[]],
      ['bits24',form('MAUD',chunk('MHDR',mhdr({bits:24})),chunk('MDAT',payload(96))),176,[]],
      ['s16-alaw',form('MAUD',chunk('MHDR',mhdr({bits:16,compression:2})),chunk('MDAT',payload(100))),176,[]],
      ['den0',form('MAUD',chunk('MHDR',mhdr({den:0})),chunk('MDAT',payload(100))),183,[]],
      ['channels0',form('MAUD',chunk('MHDR',mhdr({channels:0})),chunk('MDAT',payload(100))),183,[]],
      ['mhdr31',form('MAUD',chunk('MHDR',mhdr({size:31})),chunk('MDAT',payload(100))),183,[]],
      ['chan-first',form('MAUD',chan(6),...valid),183,[]],
      ['chan3',form('MAUD',chunk('MHDR',mhdr()),chunk('CHAN',payload(3)),chunk('MDAT',payload(100))),183,[]],
      ['no-mhdr',form('MAUD',chunk('MDAT',payload(100))),183,[]],
      ['8svx-fib',form('8SVX',vhdr(1),chunk('BODY',payload(100))),null,[]],
      ['8svx-pcm',form('8SVX',vhdr(0),chunk('BODY',payload(100))),null,[]],
      ['16sv',form('16SV',vhdr(0),chunk('BODY',payload(100))),null,['-f','iff']],
      ['vhdr-in-maud',form('MAUD',vhdr(0),...valid),null,[]],
      ['mdat-beyond-eof',truncated.subarray(0,truncated.length-10),null,[]],
      ['partial-frame',form('MAUD',chunk('MHDR',mhdr({bits:16})),chunk('MDAT',payload(101))),null,[]],
      ['no-mdat',form('MAUD',chunk('MHDR',mhdr())),null,[]],
      ['input-seek',form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(16000))),null,['-ss','0.5']]
    ];
    for(const [name,bytes,status,args]of cases){
      writeFileSync(join(root,`${name}.iff`),bytes);
      const expected=spawnSync(native,['-v','error',...args,'-i',join(root,`${name}.iff`),'-f','framecrc','-']),result=await ffmpeg.exec([...args,'-i',`/${name}.iff`,'-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).toBe(status??0);
      if(status===null)expect(result.exitCode,name).not.toBe(0);else expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(status);
      expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native IFF MAUD edge layouts: odd MDAT without its pad byte, empty MDAT, repeated MHDR and MDAT, empty NAME for raw',async()=>{
  const {root,ffmpeg}=await harness('edgeffmpeg-iff-layout-');let compared=0;
  try{
    const cases:Array<[string,Uint8Array,string?]>=[
      ['odd-unpadded',form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(101),false))],
      ['odd-padded-then-chunk',form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(8193)),chunk('XTRA',payload(3)))],
      ['empty-mdat',form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',new Uint8Array(0)))],
      ['repeated',form('MAUD',chunk('MHDR',mhdr({channels:3})),chunk('MDAT',payload(30)),chunk('MHDR',mhdr({bits:16,channels:2,num:48000,den:2})),chunk('MDAT',payload(4*50,1))),'s16be'],
      ['mhdr-64',form('MAUD',chunk('MHDR',mhdr({size:64,bits:8,compression:3})),chunk('MDAT',payload(300))),'mulaw'],
      ['empty-name',form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(40)),chunk('NAME',new Uint8Array(0)))]
    ];
    for(const [name,bytes,raw='u8']of cases)for(const args of [['-c:a','copy','-bitexact','-f','framecrc'],['-c:a','pcm_s16le','-bitexact','-f','framecrc'],['-c:a','copy','-f',raw]]){
      writeFileSync(join(root,`${name}.iff`),bytes);
      const expected=execFileSync(native,['-v','error','-i',join(root,`${name}.iff`),...args,'-']),out=`/${name}-${args.at(-1)}-${args[1]}`,result=await ffmpeg.exec(['-i',`/${name}.iff`,...args,out]);
      expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${name}/${args.join(' ')}`).toBe(true);compared++;
    }
    expect(compared).toBe(6*3);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
