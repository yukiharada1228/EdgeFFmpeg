import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000};
const rawFormat=(codec:string)=>codec==='pcm_alaw'?'alaw':codec==='pcm_mulaw'?'mulaw':codec.slice(4);
interface Sphere {readonly lines:readonly string[];readonly headerSize?:number;readonly eol?:string;readonly data:Uint8Array;readonly first?:string;readonly pad?:boolean}
/** NIST_1A, the header_size line, key lines, space padding to header_size, then the payload. */
function sphere({lines,headerSize=1024,eol='\n',data,first='NIST_1A\n',pad=true}:Sphere):Buffer{
  const text=Buffer.from(first+`${String(headerSize).padStart(7)}\n`+lines.map(line=>line+eol).join(''),'latin1');
  return Buffer.concat([text,Buffer.alloc(pad?Math.max(0,headerSize-text.length):0,0x20),data]);
}
const payload=(bytes:number,seed:number)=>Uint8Array.from({length:bytes},(_,i)=>(i*131+seed*17+(i>>3))&255);
function checkReference(){
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+nistsphere\s/);
}
function nativeRun(args:readonly string[],path:string):{status:number;bytes:Buffer|null}{
  const run=spawnSync(native,['-v','error','-y',...args,path],{timeout:30000});
  return {status:run.status??-1,bytes:run.status===0&&existsSync(path)?readFileSync(path):null};
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget})};}
it('matches native NIST SPHERE copy framecrc raw and WAV output across codings byte formats widths channels and rates',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-nist-');
  try{
    let compared=0,refused=0;
    for(const coding of ['pcm','alaw','ulaw','mu-law'])for(const format of ['01','10','1'])for(const bytes of [1,2,3,4])for(const channels of [1,3])for(const rate of [8000,44100]){
      const name=`${coding}-${format}-${bytes}-${channels}-${rate}`,frames=67+bytes;
      writeFileSync(join(root,`${name}.sph`),sphere({lines:[`channel_count -i ${channels}`,`sample_byte_format -s${format.length} ${format}`,`sample_n_bytes -i ${bytes}`,`sample_rate -i ${rate}`,`sample_coding -s${coding.length} ${coding}`,`sample_count -i ${frames}`,'end_head'],data:payload(frames*channels*bytes,bytes+channels)}));
      const companded=coding!=='pcm';
      if(companded&&bytes!==1){
        const result=await ffmpeg.exec(['-i',`/${name}.sph`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);expect(result.exitCode,name).toBe(1);expect(result.diagnostics.at(-1)?.message).toMatch(/companded samples are not implemented/);expect(existsSync(join(root,`${name}.crc`))).toBe(false);refused++;continue;
      }
      const codec=companded?(coding==='alaw'?'pcm_alaw':'pcm_mulaw'):bytes===1?'pcm_s8':`pcm_s${bytes*8}${format==='10'?'be':'le'}`;
      for(const [suffix,before,after] of [['copy.crc',[],['-c:a','copy','-bitexact','-f','framecrc']],['copy.raw',[],['-c:a','copy','-f',rawFormat(codec)]],['decode.wav',['-cpuflags','0'],['-bitexact','-f','wav']],['decode.f32',['-cpuflags','0'],['-f','f32le']]] as const){
        const expected=nativeRun([...before,'-i',join(root,`${name}.sph`),...after],join(root,`native-${name}.${suffix}`)),out=`/${name}.${suffix}`,result=await ffmpeg.exec([...before,'-i',`/${name}.sph`,...after,out]);
        expect(expected.status,`${name}/${suffix}`).toBe(0);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        expect(readFileSync(join(root,out.slice(1))).equals(expected.bytes!),`${name}/${suffix}`).toBe(true);compared++;
      }
    }
    expect([compared,refused]).toEqual([4*(48+3*12),3*36]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native NIST SPHERE seek duration and frame-limit timing with copy and decode',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-nist-time-');
  try{
    let compared=0;
    for(const [count,label] of [[4300,'exact'],[null,'absent'],[999,'mismatch']] as const){
      const lines=['channel_count -i 2','sample_n_bytes -i 2','sample_byte_format -s2 01','sample_rate -i 8000',...(count===null?[]:[`sample_count -i ${count}`]),'end_head'];
      writeFileSync(join(root,`${label}.sph`),sphere({lines,data:payload(4300*4,9)}));
      const profiles=[{before:[],after:[]},{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:[],after:['-frames:a','2']},{before:['-ss','0.25'],after:['-t','0.1']},{before:[],after:['-t','0.3']}];
      for(const [index,profile] of profiles.entries())for(const copy of [true,false])for(const [format,extra] of [['framecrc',['-bitexact']],['wav',['-bitexact']],['s16le',[]]] as const){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1','-c:a','pcm_s16le']),...extra,'-f',format],out=`/${label}-${index}-${copy}.${format}`;
        const expected=nativeRun([...before,'-i',join(root,`${label}.sph`),...after],join(root,'native'+out.slice(1))),result=await ffmpeg.exec([...before,'-i',`/${label}.sph`,...after,out]);
        if(label==='mismatch'&&profile.before.length){expect(result.exitCode).toBe(1);expect(result.diagnostics.at(-1)?.message).toMatch(/sample_count that differs/);continue;}
        expect(expected.status,out).toBe(0);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected.bytes!),`${label}/${index}/${copy}/${format}`).toBe(true);compared++;
      }
    }
    expect(compared).toBe(3*5*6-2*6);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native NIST SPHERE header text edges and native exit statuses for refused headers',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-nist-text-');
  try{
    const base=['channel_count -i 2','sample_n_bytes -i 2','sample_rate -i 16000'],data=payload(4*101,3);
    // Accepted by both: native bytes compared for copy framecrc and raw (and WAV when no metadata).
    const accepted:Record<string,Sphere>={
      crlf:{lines:[...base,'end_head'],eol:'\r\n',data},cr:{lines:[...base,'end_head'],eol:'\r',data},
      small:{lines:[...base,'end_head'],headerSize:100,data},exact:{lines:[...base,'end_head'],headerSize:86,data},
      blank:{lines:['',...base,'   ','end_head'],data},upper:{lines:[...base,'sample_coding -s3 PCM','sample_byte_format -s2 10','END_HEAD_not','end_head'],data},
      sigbits:{lines:[...base,'sample_sig_bits -i 16','end_head'],data},sigonly:{lines:['channel_count -i 2','sample_sig_bits -i 24','sample_rate -i 16000','end_head'],data:payload(6*50,5)},
      tabs:{lines:['channel_count\t-i\t2','sample_n_bytes -i 2abc','sample_rate -i +16000','end_head trailing'],data},
      mulawformat:{lines:['channel_count -i 1','sample_n_bytes -i 1','sample_rate -i 8000','sample_byte_format -s6 mu-law','end_head'],data},
      declared:{lines:[...base,'end_head'],first:'not a magic\n',data},nulline:{lines:[...base,'\0junk','end_head'],data},
      longline:{lines:[...base,'x'.repeat(254),'end_head'],data},
      meta:{lines:[...base,'database_id -s5 TIMIT','utterance_id -s8 dr1_fcjf','end_head'],data},
    };
    let compared=0,refused=0;
    for(const [name,spec] of Object.entries(accepted)){
      writeFileSync(join(root,`${name}.sph`),sphere(spec));const declared=name==='declared'?['-f','nistsphere']:[];
      for(const [suffix,after] of [['crc',['-c:a','copy','-bitexact','-f','framecrc']],['raw',['-c:a','copy','-f',({upper:'s16be',sigonly:'s24le',mulawformat:'mulaw'} as Record<string,string>)[name]??'s16le']],['wav',['-bitexact','-f','wav']],['w64',['-c:a','pcm_s16le','-f','w64']]] as const){
        const expected=nativeRun([...declared,'-i',join(root,`${name}.sph`),...after],join(root,`native-${name}.${suffix}`)),out=`/${name}.${suffix}`,result=await ffmpeg.exec([...declared,'-i',`/${name}.sph`,...after,out]);
        expect(expected.status,name).toBe(0);
        if(name==='meta'&&suffix==='wav'){expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe('Input metadata for the WAV muxer is not implemented');expect(existsSync(join(root,out.slice(1)))).toBe(false);refused++;continue;}
        expect(result.exitCode,`${name}/${suffix} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected.bytes!),`${name}/${suffix}`).toBe(true);compared++;
      }
    }
    // Refused by native and EdgeFFmpeg with the same exit status before any output exists.
    const nativeRefused:Record<string,[Sphere,number]>={
      noend:[{lines:base,pad:false,data:new Uint8Array(0)},187],pasthead:[{lines:[...base,'end_head'],headerSize:60,data},183],atsize:[{lines:[...base,'end_head'],headerSize:85,data},183],
      zerosize:[{lines:[...base,'end_head'],headerSize:0,data},183],channels0:[{lines:['channel_count -i 0',...base.slice(1),'end_head'],data},183],channelsbig:[{lines:['channel_count -i 32768',...base.slice(1),'end_head'],data},183],
      bytesbig:[{lines:[...base,'sample_n_bytes -i 4096','end_head'],data},183],bytesneg:[{lines:[...base,'sample_n_bytes -i -1','end_head'],data},183],sig0:[{lines:[...base,'sample_sig_bits -i 0','end_head'],data},183],
      format:[{lines:[...base,'sample_byte_format -s4 0123','end_head'],data},176],channelsmissing:[{lines:['channel_count -i',...base.slice(1),'end_head'],data},183],
    };
    for(const [name,[spec,status]] of Object.entries(nativeRefused)){
      writeFileSync(join(root,`${name}.sph`),sphere(spec));
      const expected=nativeRun(['-i',join(root,`${name}.sph`),'-c:a','copy','-f','framecrc'],join(root,`native-${name}.crc`)),result=await ffmpeg.exec(['-i',`/${name}.sph`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(expected.status,name).toBe(status);expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(status);expect(existsSync(join(root,`${name}.crc`))).toBe(false);refused++;
    }
    // Accepted by native but outside the implemented scope: explicit refusal before output.
    const edgeRefused:Record<string,[Sphere,RegExp]>={
      sig12:[{lines:[...base,'sample_sig_bits -i 12','end_head'],data},/12 significant bits/],shorten:[{lines:[...base,'sample_coding -s26 pcm,embedded-shorten-v2.00','end_head'],data},/Shorten/],
      coding:[{lines:[...base,'sample_coding -s4 ulaw2','end_head'],data},/sample coding ulaw2/],toolong:[{lines:[...base,'x'.repeat(256),'end_head'],data},/longer than 255/],
      partial:[{lines:[...base,'end_head'],data:data.subarray(1)},/partial sample frame/],past:[{lines:[...base,'end_head'],headerSize:2000,pad:false,data:new Uint8Array(0)},/past EOF/],
      norate:[{lines:[base[0]!,base[1]!,'end_head'],data},/sample_rate/],bits64:[{lines:[...base.slice(0,1),'sample_n_bytes -i 8',base[2]!,'end_head'],data:payload(16*10,1)},/64-bit PCM/],
    };
    const nativeStatus:Record<string,number>={};
    for(const [name,[spec,message]] of Object.entries(edgeRefused)){
      writeFileSync(join(root,`${name}.sph`),sphere(spec));
      const result=await ffmpeg.exec(['-i',`/${name}.sph`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);nativeStatus[name]=nativeRun(['-i',join(root,`${name}.sph`),'-c:a','copy','-f','framecrc'],join(root,`native-${name}.crc`)).status;
      expect(result.exitCode,name).toBe(1);expect(result.diagnostics.at(-1)?.message).toMatch(message);expect(existsSync(join(root,`${name}.crc`))).toBe(false);refused++;
    }
    // Native accepts these (no sample rate fails later in its encoder with EINVAL).
    expect(nativeStatus).toEqual({sig12:0,shorten:0,coding:0,toolong:0,partial:0,past:0,norate:234,bits64:0});
    expect([compared,refused]).toEqual([14*4-1,1+11+8]);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
