import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const muxers=['md5','hash','crc','streamhash'] as const;
const codecs=['pcm_u8','pcm_s8','pcm_s16le','pcm_s16be','pcm_u16le','pcm_u16be','pcm_s24le','pcm_s24be','pcm_u24le','pcm_u24be','pcm_s32le','pcm_s32be','pcm_u32le','pcm_u32be','pcm_f32le','pcm_f32be','pcm_f64le','pcm_f64be','pcm_alaw','pcm_mulaw'] as const;
const rawFormat=(codec:string)=>codec==='pcm_alaw'?'alaw':codec==='pcm_mulaw'?'mulaw':codec.slice(4);
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000};
function checkReference(){
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const listing=execFileSync(native,['-v','error','-muxers'],{encoding:'utf8'});for(const name of muxers)expect(listing).toMatch(new RegExp(`E\\s+${name}\\s`));
}
function synth(samples:number,channels:number,seed:number):Uint8Array{const bytes=new Uint8Array(samples*channels*2),view=new DataView(bytes.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,(i*3137+seed*7919)%65536-32768,true);return bytes;}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget})};}
it('matches native md5 hash crc and streamhash files for every PCM codec channel count rate and length',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-hash-matrix-');
  try{
    let compared=0;
    for(const channels of [1,2,6])for(const rate of [8000,44100])for(const samples of [0,1,4097]){
      const input=`in-${channels}-${rate}-${samples}.raw`;writeFileSync(join(root,input),synth(samples,channels,rate+channels));
      const args=['-f','s16le','-ar',String(rate),'-ac',String(channels),'-i'];
      for(const codec of codecs){
        const name=`${codec}-${channels}-${rate}-${samples}`,outputs=muxers.flatMap(muxer=>['-c:a',codec,'-f',muxer,join(root,`${name}.native.${muxer}`)]);
        execFileSync(native,['-v','error','-y',...args,join(root,input),...outputs],{timeout:30000});
        for(const muxer of muxers){
          const out=`/${name}.${muxer}`,result=await ffmpeg.exec([...args,`/${input}`,'-c:a',codec,'-f',muxer,out]);
          expect(result.exitCode,`${name}/${muxer} ${JSON.stringify(result.diagnostics)}`).toBe(0);
          expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`${name}.native.${muxer}`))),`${name}/${muxer}`).toBe(true);compared++;
        }
      }
    }
    expect(compared).toBe(1440);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native hash muxer files after volume filtering time and frame limits and stream copy',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-hash-profiles-');
  try{
    writeFileSync(join(root,'in.raw'),synth(9000,2,3));let compared=0;
    for(const codec of ['pcm_s16le','pcm_s24be','pcm_f32le','pcm_mulaw','pcm_u8'])execFileSync(native,['-v','error','-y','-f','s16le','-ar','44100','-ac','2','-i',join(root,'in.raw'),'-c:a',codec,'-f',rawFormat(codec),join(root,`in.${codec}`)]);
    execFileSync(native,['-v','error','-y','-f','s16le','-ar','44100','-ac','2','-i',join(root,'in.raw'),'-c:a','pcm_s24le','-bitexact',join(root,'in.wav')]);
    const profiles:{readonly label:string;readonly before:readonly string[];readonly input:string;readonly after:readonly string[]}[]=[
      {label:'volume',before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2'],input:'in.raw',after:['-af','volume=0.5']},
      {label:'volume-f32',before:['-cpuflags','0','-f','s16le','-ar','44100','-ac','2'],input:'in.raw',after:['-af','volume=0.5:precision=fixed','-c:a','pcm_f32be']},
      {label:'t',before:['-f','s16le','-ar','44100','-ac','2'],input:'in.raw',after:['-t','0.05']},
      {label:'frames',before:['-f','s16le','-ar','44100','-ac','2'],input:'in.raw',after:['-frames:a','3','-c:a','pcm_s32le']},
      {label:'wav-copy',before:[],input:'in.wav',after:['-c:a','copy']},
      {label:'wav-copy-t',before:[],input:'in.wav',after:['-t','0.1','-c:a','copy']},
      {label:'wav-decode',before:[],input:'in.wav',after:[]},
      ...(['pcm_s16le','pcm_s24be','pcm_f32le','pcm_mulaw','pcm_u8'] as const).map(codec=>({label:`copy-${codec}`,before:['-f',rawFormat(codec),'-ar','44100','-ac','2'],input:`in.${codec}`,after:['-c:a','copy']}))
    ];
    for(const profile of profiles)for(const muxer of muxers){
      const out=`/${profile.label}.${muxer}`,nativePath=join(root,`native-${profile.label}.${muxer}`);
      execFileSync(native,['-v','error','-y',...profile.before,'-i',join(root,profile.input),...profile.after,'-f',muxer,nativePath],{timeout:30000});
      const result=await ffmpeg.exec([...profile.before,'-i',`/${profile.input}`,...profile.after,'-f',muxer,out]);
      expect(result.exitCode,`${profile.label}/${muxer} ${JSON.stringify(result.diagnostics)}`).toBe(0);
      expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(nativePath)),`${profile.label}/${muxer}`).toBe(true);compared++;
    }
    expect(compared).toBe(48);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses -hash before any output exists while native accepts murmur3 and sha256',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-hash-refusals-');
  try{
    writeFileSync(join(root,'in.raw'),synth(100,1,1));let checked=0;
    for(const muxer of ['md5','hash','streamhash','crc'] as const)for(const value of ['murmur3','sha256']){
      const nativePath=join(root,`native-${muxer}-${value}`),nativeRun=spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'in.raw'),'-hash',value,'-f',muxer,nativePath],{encoding:'utf8',timeout:30000});
      // Native's hash muxers parse -hash through their AVOption table; crc has none, so the option is unused there and ignored.
      expect(nativeRun.status,`${muxer}/${value} ${nativeRun.stderr}`).toBe(0);expect(existsSync(nativePath)).toBe(true);
      if(muxer!=='crc')expect(readFileSync(nativePath,'utf8')).toMatch(new RegExp(`^${muxer==='streamhash'?'0,a,':''}${value==='murmur3'?'murmur3':'SHA256'}=[0-9a-f]+\\n$`));
      const out=`/${muxer}-${value}`,result=await ffmpeg.exec(['-f','s16le','-i','/in.raw','-hash',value,'-f',muxer,out]);
      expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)).toMatchObject({code:'invalid-arguments',message:'Unsupported option: -hash'});expect(existsSync(join(root,out.slice(1)))).toBe(false);checked++;
    }
    expect(checked).toBe(8);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
