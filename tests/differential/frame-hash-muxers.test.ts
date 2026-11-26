import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const muxers=['framemd5','framehash'] as const;
const codecs=['pcm_u8','pcm_s8','pcm_s16le','pcm_s16be','pcm_u16le','pcm_u16be','pcm_s24le','pcm_s24be','pcm_u24le','pcm_u24be','pcm_s32le','pcm_s32be','pcm_u32le','pcm_u32be','pcm_f32le','pcm_f32be','pcm_f64le','pcm_f64be','pcm_alaw','pcm_mulaw'] as const;
const rawFormat=(codec:string)=>codec==='pcm_alaw'?'alaw':codec==='pcm_mulaw'?'mulaw':codec.slice(4);
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
  expect(metadata.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(metadata.flags).toContain('--disable-x86asm');
  const listing=execFileSync(native,['-v','error','-muxers'],{encoding:'utf8'});for(const name of muxers)expect(listing).toMatch(new RegExp(`E\\s+${name}\\s`));
}
function synth(samples:number,channels:number,seed:number):Uint8Array{const bytes=new Uint8Array(samples*channels*2),view=new DataView(bytes.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,(i*3137+seed*7919)%65536-32768,true);return bytes;}
async function setup(prefix:string,io:number){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:io,maxWriteBytes:io});
  return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:262144,maxBufferBytes:io,maxPendingPackets:2,maxCpuTimeMs:1000}})};
}
it('matches native framemd5 and framehash text for wav and raw inputs at every channel count rate and PCM codec and stream copy',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-framehash-matrix-',4096);
  try{
    let compared=0;
    for(const kind of ['raw','wav'] as const)for(const channels of [1,2,6])for(const rate of [8000,44100,48000]){
      const label=`${kind}-${channels}-${rate}`,raw=join(root,`${label}.raw`);writeFileSync(raw,synth(2500,channels,rate+channels));
      const declared=['-f','s16le','-ar',String(rate),'-ac',String(channels)];
      if(kind==='wav')execFileSync(native,['-v','error','-y',...declared,'-i',raw,'-bitexact',join(root,`${label}.wav`)],{timeout:30000});
      const input=kind==='wav'?`${label}.wav`:`${label}.raw`,args=kind==='wav'?[]:declared;
      const outputs=[...codecs,'copy'].flatMap(codec=>muxers.flatMap(muxer=>['-c:a',codec,'-f',muxer,join(root,`${label}-${codec}.native.${muxer}`)]));
      execFileSync(native,['-v','error','-y',...args,'-i',join(root,input),...outputs],{timeout:60000});
      for(const codec of [...codecs,'copy'])for(const muxer of muxers){
        const name=`${label}-${codec}.${muxer}`,result=await ffmpeg.exec([...args,'-i',`/${input}`,'-c:a',codec,'-f',muxer,`/${name}`]);
        expect(result.exitCode,`${name} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,name),'utf8'),name).toBe(readFileSync(join(root,`${label}-${codec}.native.${muxer}`),'utf8'));compared++;
      }
    }
    expect(compared).toBe(756);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native frame hash text with bitexact flags, regrouping filter chains, output time and frame limits and copy',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-framehash-profiles-',8192);
  try{
    writeFileSync(join(root,'in.raw'),synth(5000,2,3));
    execFileSync(native,['-v','error','-y','-f','s16le','-ar','44100','-ac','2','-i',join(root,'in.raw'),'-c:a','pcm_s24le','-bitexact',join(root,'in.wav')]);
    const raw=['-f','s16le','-ar','44100','-ac','2'],copied=['pcm_u8','pcm_s24be','pcm_f32le','pcm_f64be','pcm_mulaw'] as const;
    for(const codec of copied)execFileSync(native,['-v','error','-y',...raw,'-i',join(root,'in.raw'),'-c:a',codec,'-f',rawFormat(codec),join(root,`in.${codec}`)],{timeout:30000});
    const profiles:{readonly label:string;readonly before:readonly string[];readonly input:string;readonly after:readonly string[]}[]=[
      {label:'bitexact',before:raw,input:'in.raw',after:['-bitexact']},
      {label:'fflags',before:[...raw,'-fflags','+bitexact'],input:'in.raw',after:['-fflags','+bitexact']},
      {label:'input-bitexact',before:[...raw,'-bitexact'],input:'in.raw',after:[]},
      {label:'setnsamples',before:raw,input:'in.raw',after:['-af','asetnsamples=n=300:p=0']},
      {label:'setnsamples-pad',before:raw,input:'in.raw',after:['-af','asetnsamples=n=777','-c:a','pcm_s32be']},
      {label:'apad',before:raw,input:'in.raw',after:['-af','apad=pad_len=1500']},
      {label:'apad-packet',before:raw,input:'in.raw',after:['-af','apad=pad_len=1000:packet_size=333','-bitexact']},
      {label:'apad-whole',before:raw,input:'in.raw',after:['-af','apad=whole_len=7000','-c:a','pcm_u8']},
      {label:'chain',before:raw,input:'in.raw',after:['-af','asetnsamples=n=1000:p=0,apad=pad_len=600,asetnsamples=n=250:p=0']},
      {label:'chain-t',before:raw,input:'in.raw',after:['-af','apad=pad_len=4000:packet_size=600,asetnsamples=n=999:p=0','-t','0.15']},
      {label:'ss',before:raw,input:'in.raw',after:['-ss','0.01']},
      {label:'t',before:raw,input:'in.raw',after:['-t','0.05']},
      {label:'ss-t',before:raw,input:'in.raw',after:['-ss','0.015','-t','0.07','-c:a','pcm_f32le']},
      {label:'frames',before:raw,input:'in.raw',after:['-frames:a','3','-c:a','pcm_s32le']},
      {label:'frames-setnsamples',before:raw,input:'in.raw',after:['-af','asetnsamples=n=100:p=0','-frames:a','7']},
      {label:'input-ss',before:[...raw,'-ss','0.02'],input:'in.raw',after:['-t','0.03']},
      {label:'raw-copy-t',before:raw,input:'in.raw',after:['-c:a','copy','-t','0.06']},
      {label:'wav-copy',before:[],input:'in.wav',after:['-c:a','copy']},
      {label:'wav-copy-ss-t',before:[],input:'in.wav',after:['-ss','0.01','-t','0.04','-c:a','copy','-bitexact']},
      {label:'wav-decode',before:[],input:'in.wav',after:[]},
      {label:'wav-apad',before:[],input:'in.wav',after:['-af','apad=pad_len=100','-c:a','pcm_s24le']},
      ...copied.map(codec=>({label:`copy-${codec}`,before:['-f',rawFormat(codec),'-ar','44100','-ac','2'],input:`in.${codec}`,after:['-c:a','copy']})),
    ];
    let compared=0;
    for(const profile of profiles){
      const outputs=muxers.flatMap(muxer=>[...profile.after,'-f',muxer,join(root,`native-${profile.label}.${muxer}`)]);
      execFileSync(native,['-v','error','-y',...profile.before,'-i',join(root,profile.input),...outputs],{timeout:30000});
      for(const muxer of muxers){
        const out=`${profile.label}.${muxer}`,result=await ffmpeg.exec([...profile.before,'-i',`/${profile.input}`,...profile.after,'-f',muxer,`/${out}`]);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out),'utf8'),out).toBe(readFileSync(join(root,`native-${profile.label}.${muxer}`),'utf8'));compared++;
      }
    }
    expect(compared).toBe(52);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
function extensibleWav(mask:number,channels:number,samples:number):Uint8Array{
  const data=samples*channels*2,bytes=new Uint8Array(68+data),view=new DataView(bytes.buffer),ascii=(offset:number,text:string)=>{for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);};
  ascii(0,'RIFF');view.setUint32(4,60+data,true);ascii(8,'WAVEfmt ');view.setUint32(16,40,true);view.setUint16(20,0xfffe,true);view.setUint16(22,channels,true);view.setUint32(24,8000,true);view.setUint32(28,8000*channels*2,true);
  view.setUint16(32,channels*2,true);view.setUint16(34,16,true);view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,mask,true);bytes.set([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113],44);ascii(60,'data');view.setUint32(64,data,true);
  for(let i=0;i<data;i++)bytes[68+i]=(i*37+mask)&255;
  return bytes;
}
it('matches native guessed, unguessed and named container layouts and refuses an unnamed container mask before any output exists',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-framehash-layouts-',256);
  try{
    let compared=0,refused=0;
    const cases:{readonly label:string;readonly args:readonly string[];readonly input:string;readonly layout:string;readonly refused:boolean}[]=[];
    for(const channels of [3,4,5,7,8]){
      writeFileSync(join(root,`in-${channels}.raw`),synth(700,channels,channels));const args=['-f','s16le','-ar','8000','-ac',String(channels)];
      cases.push({label:`guessed-${channels}`,args,input:`in-${channels}.raw`,layout:'',refused:false},{label:`unguessed-${channels}`,args:[...args,'-guess_layout_max','0'],input:`in-${channels}.raw`,layout:`${channels} channels`,refused:false});
    }
    for(const [mask,channels,layout,refusal] of [[11,3,'2.1',false],[1551,6,'5.1(side)',false],[51,4,'quad',false],[48,2,'2 channels (BL+BR)',true],[19,3,'3 channels (FL+FR+BL)',true],[0x3f000,6,'6 channels (TFL+TFC+TFR+TBL+TBC+TBR)',true]] as const){
      const input=`mask-${mask}.wav`;writeFileSync(join(root,input),extensibleWav(mask,channels,700));cases.push({label:`mask-${mask}`,args:[],input,layout,refused:refusal});
    }
    for(const entry of cases){
      execFileSync(native,['-v','error','-y',...entry.args,'-i',join(root,entry.input),...muxers.flatMap(muxer=>['-f',muxer,join(root,`native-${entry.label}.${muxer}`)])],{timeout:30000});
      for(const muxer of muxers){
        const expected=readFileSync(join(root,`native-${entry.label}.${muxer}`),'utf8');if(entry.layout)expect(expected,entry.label).toContain(`#channel_layout_name 0: ${entry.layout}\n`);
        const out=`${entry.label}.${muxer}`,result=await ffmpeg.exec([...entry.args,'-i',`/${entry.input}`,'-f',muxer,`/${out}`]);
        if(entry.refused){
          expect(result.exitCode,out).toBe(1);expect(result.diagnostics.at(-1)).toMatchObject({code:'unsupported-command',message:`Unknown channel mask for ${muxer} output`});expect(existsSync(join(root,out))).toBe(false);refused++;
        }else{expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out),'utf8'),out).toBe(expected);compared++;}
      }
    }
    expect([compared,refused]).toEqual([26,6]);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses -hash, -format_version and atrim chains before any output exists while native accepts them',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-framehash-options-',256);
  try{
    writeFileSync(join(root,'in.raw'),synth(100,1,1));let checked=0;
    for(const muxer of muxers)for(const [option,value,pattern] of [['-hash','sha256',/^#hash: SHA256$/m],['-hash','crc32',/^#hash: CRC32$/m],['-format_version','1',/^#version: 1$/m]] as const){
      const nativePath=join(root,`native-${muxer}${option}-${value}`),nativeRun=spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'in.raw'),option,value,'-f',muxer,nativePath],{encoding:'utf8',timeout:30000});
      expect(nativeRun.status,`${muxer}/${option} ${nativeRun.stderr}`).toBe(0);expect(readFileSync(nativePath,'utf8')).toMatch(pattern);
      const out=`/${muxer}${option}-${value}`,result=await ffmpeg.exec(['-f','s16le','-i','/in.raw',option,value,'-f',muxer,out]);
      expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)).toMatchObject({code:'invalid-arguments',message:`Unsupported option: ${option}`});expect(existsSync(join(root,out.slice(1)))).toBe(false);checked++;
    }
    for(const muxer of muxers)for(const chain of ['atrim=start_sample=10','asetnsamples=n=30:p=0,atrim=end_sample=70']){
      const nativeRun=spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'in.raw'),'-af',chain,'-f',muxer,join(root,`native-${muxer}-atrim`)],{encoding:'utf8',timeout:30000});expect(nativeRun.status,nativeRun.stderr).toBe(0);
      const out=`/${muxer}-atrim`,result=await ffmpeg.exec(['-f','s16le','-i','/in.raw','-af',chain,'-f',muxer,out]);
      expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)).toMatchObject({code:'unsupported-filter'});expect(existsSync(join(root,out.slice(1)))).toBe(false);checked++;
    }
    expect(checked).toBe(10);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
