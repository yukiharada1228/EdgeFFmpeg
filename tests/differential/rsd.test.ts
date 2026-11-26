import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:262144,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:2000};
/** Deterministic payload; the RSD layout is written here, independent of the module: "RSD"+version, tag, RL32 channels, depth, rate, unknown, start. */
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};}
function dump(version:number,tag:string,channels:number,rate:number,start:number,payload:number,seed:number,startField=start):Uint8Array{
  const next=random(seed),bytes=new Uint8Array(Math.max(28,start+payload)),view=new DataView(bytes.buffer);
  for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(next()*256);
  bytes.set([0x52,0x53,0x44,0x30+version,...[...tag].map(c=>c.charCodeAt(0))]);
  view.setUint32(8,channels,true);view.setUint32(12,16,true);view.setUint32(16,rate,true);view.setUint32(20,0,true);view.setInt32(24,startField,true);
  return bytes;
}
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.slice(0,8)).toBe('946fcce0');expect(metadata.flags).toContain('--disable-x86asm');
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+rsd\s/);
}
type Output=readonly [suffix:string,args:readonly string[]];
/** One native call writes every output of a file; EdgeFFmpeg runs each output separately and must match byte for byte. */
async function compare(ffmpeg:FFmpeg,root:string,name:string,before:readonly string[],outputs:readonly Output[]):Promise<number>{
  execFileSync(native,['-v','error','-y',...before,'-i',join(root,name),...outputs.flatMap(([suffix,args])=>[...args,join(root,`native.${name}.${suffix}`)])],{timeout:60000});
  for(const [suffix,args] of outputs){
    const out=`/${name}.${suffix}`,run=await ffmpeg.exec([...before,'-i',`/${name}`,...args,out]);
    expect(run.exitCode,`${out} ${JSON.stringify(run.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(join(root,`native.${name}.${suffix}`))),out).toBe(true);
  }
  return outputs.length;
}
const raw=(tag:string)=>tag==='PCMB'?'s16be':'s16le';
const whole=(tag:string):Output[]=>[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['decode.crc',['-c:a','pcm_s16le','-bitexact','-f','framecrc']],['decode.wav',['-bitexact','-f','wav']],['decode.raw',['-f','s16le']],['copy.raw',['-c:a','copy','-f',raw(tag)]]];
it('matches native RSD copy and decode framecrc, WAV and raw for versions 2 3 4 and 6, PCM and PCMB, 1 2 4 and 8 channels',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rsd-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0,files=0;
    // Non-v4 starts: after the header, at 0x800, inside the header (24) and at 0 (absolute seek back over the header).
    const starts=[32,0x800,24,0],rates=[22050,32000,48000,8000];
    for(const [vi,version] of [2,3,4,6].entries())for(const tag of ['PCM ','PCMB'])for(const [ci,channels] of [1,2,4,8].entries()){
      const start=version===4?0x800:starts[(vi+ci)%4]!,packets=1+(vi+ci)%3,name=`v${version}-${tag.trim()}-c${channels}.bin`;
      writeFileSync(join(root,name),dump(version,tag,channels,rates[ci]!,start,packets*1024,vi*97+ci*13+tag.length,version===4?12345:start));files++;
      compared+=await compare(ffmpeg,root,name,[],whole(tag));
    }
    expect([files,compared]).toEqual([32,160]);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches native RSD output -ss and -t for copy and decode, short final packets on decode, and declared -f rsd',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rsd-time-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let compared=0;
    for(const tag of ['PCM ','PCMB'])for(const channels of [1,2,4,8]){
      const name=`t-${tag.trim()}-c${channels}.bin`;writeFileSync(join(root,name),dump(3,tag,channels,22050,32,4096,channels*7+tag.length));
      compared+=await compare(ffmpeg,root,name,[],[['t.copy.crc',['-t','0.02','-c:a','copy','-bitexact','-f','framecrc']],['ss.copy.crc',['-ss','0.01','-c:a','copy','-bitexact','-f','framecrc']],['sst.decode.crc',['-ss','0.01','-t','0.02','-c:a','pcm_s16le','-bitexact','-f','framecrc']],['sst.wav',['-ss','0.005','-t','0.01','-bitexact','-f','wav']],['t.raw',['-t','0.003','-f','s16le']]]);
    }
    // Short final packets: native copy flags the tail F=0x3 (refused below); decoding matches.
    for(const tag of ['PCM ','PCMB'])for(const [channels,payload] of [[1,1026],[2,2500],[4,3080],[8,1040]] as const){
      const name=`short-${tag.trim()}-c${channels}.bin`;writeFileSync(join(root,name),dump(2,tag,channels,16000,32,payload,payload));
      compared+=await compare(ffmpeg,root,name,[],[['decode.crc',['-c:a','pcm_s16le','-bitexact','-f','framecrc']],['decode.wav',['-bitexact','-f','wav']],['decode.raw',['-f','s16le']],['t.crc',['-ss','0.002','-t','0.01','-c:a','pcm_s16le','-bitexact','-f','framecrc']]]);
      expect(execFileSync(native,['-v','error','-i',join(root,name),'-c:a','copy','-f','framecrc','-'],{encoding:'utf8'})).toMatch(/, F=0x3\n$/);
      const copy=await ffmpeg.exec(['-i',`/${name}`,'-c:a','copy','-f','framecrc',`/${name}.copy.crc`]);
      expect([copy.exitCode,copy.diagnostics.at(-1)?.code,copy.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','RSD stream copy of a short final packet is not implemented']);expect(existsSync(join(root,`${name}.copy.crc`))).toBe(false);
    }
    // Declared: a rate above 384000 scores 12 natively, so it is opened only with -f rsd; 512 channels give one-sample packets; a start at EOF is empty.
    writeFileSync(join(root,'rate.bin'),dump(5,'PCM ',2,400000,32,2048,5));compared+=await compare(ffmpeg,root,'rate.bin',['-f','rsd'],whole('PCM '));
    writeFileSync(join(root,'wide.bin'),dump(6,'PCMB',512,8000,32,2048,6));compared+=await compare(ffmpeg,root,'wide.bin',['-f','rsd'],[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['copy.raw',['-c:a','copy','-f','s16be']]]);
    writeFileSync(join(root,'empty.bin'),dump(3,'PCM ',2,8000,64,0,7));compared+=await compare(ffmpeg,root,'empty.bin',[],[['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['decode.raw',['-f','s16le']]]);
    expect(compared).toBe(40+32+5+2+2);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('refuses inputs native rejects or that the module does not mirror before any output, with native statuses',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rsd-errors-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    const beyond=dump(3,'PCM ',2,8000,32,1024,4,4000);
    // Native statuses: unknown tag INVALIDDATA (183), OGG PATCHWELCOME (176); native exits 0 for the rest:
    // 3 channels gives 1020-byte frames and decoder errors, a VAG tag decodes ADPCM, a start beyond EOF is empty, a 400000 Hz rate scores 12, so another demuxer (bintext for .bin) takes the file as video and the s16le output fails with EINVAL (host errno).
    const cases:Array<[string,Uint8Array,readonly string[],number,number,RegExp]>=[
      ['unknown',dump(3,'ABCD',2,8000,32,1024,1),[],183,183,/^Unknown RSD codec tag: "ABCD"$/],
      ['ogg',dump(3,'OGG ',2,8000,32,1024,2),[],176,176,/^RSD codec tag OGG is not implemented$/],
      ['three',dump(3,'PCM ',3,8000,32,1536,3),[],0,1,/^RSD 3-channel packets that split sample frames are not implemented$/],
      ['three-declared',dump(3,'PCM ',3,8000,32,1536,3),['-f','rsd'],0,1,/^RSD 3-channel packets that split sample frames are not implemented$/],
      ['vag',dump(3,'VAG ',2,8000,32,1024,5),[],0,1,/^RSD codec tag "VAG " is not implemented$/],
      ['beyond',beyond,[],0,1,/^RSD data start beyond the end of the input is not implemented$/],
      ['score12',dump(3,'PCM ',2,400000,32,2048,6),[],256-constants.errno.EINVAL,1,/^Unsupported audio container signature$/]
    ];
    for(const [name,bytes,declare,nativeStatus,status,message] of cases){
      writeFileSync(join(root,`${name}.bin`),bytes);
      const nativeRun=spawnSync(native,['-v','error','-y',...declare,'-i',join(root,`${name}.bin`),'-f','s16le',join(root,`native.${name}.raw`)],{timeout:15000});
      expect(nativeRun.status,name).toBe(nativeStatus);
      const result=await ffmpeg.exec([...declare,'-i',`/${name}.bin`,'-f','s16le',`/${name}.raw`]);
      expect(result.exitCode,name).toBe(status);expect(result.diagnostics.at(-1)?.message,name).toMatch(message);expect(result.outputs).toEqual([]);expect(existsSync(join(root,`${name}.raw`)),name).toBe(false);
    }
    // 3 channels: copy packets stay 1024 bytes (170 samples), and decoding drops the split frame bytes with errors (1020-byte frames).
    expect(spawnSync(native,['-v','error','-i',join(root,'three.bin'),'-c:a','copy','-f','framecrc','-'],{encoding:'utf8'}).stdout).toMatch(/^0,\s+0,\s+0,\s+170,\s+1024,/m);
    const threeDecode=spawnSync(native,['-v','error','-i',join(root,'three.bin'),'-f','framecrc','-'],{encoding:'utf8'});expect(threeDecode.stdout).toMatch(/^0,\s+0,\s+0,\s+170,\s+1020,/m);expect(threeDecode.stderr).toMatch(/Invalid PCM packet/);
    // Input -ss goes through the generic index natively; refused here.
    writeFileSync(join(root,'seek.bin'),dump(3,'PCM ',2,8000,32,4096,8));
    const seek=await ffmpeg.exec(['-ss','0.01','-i','/seek.bin','-f','s16le','/seek.raw']);expect([seek.exitCode,seek.diagnostics.at(-1)?.message]).toEqual([1,'RSD input seeking is not implemented']);expect(existsSync(join(root,'seek.raw'))).toBe(false);
    // rsd is demux-only natively and here.
    expect(spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'seek.bin'),'-f','rsd',join(root,'out.rsd')],{timeout:15000}).status).not.toBe(0);
    const mux=await ffmpeg.exec(['-f','s16le','-i','/seek.bin','-f','rsd','/out.rsd']);expect(mux.exitCode).not.toBe(0);expect(existsSync(join(root,'out.rsd'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses declared RSD sample rates above 1073741823, where native decode timestamps leave the sample clock, and matches native at 1073741823',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-rsd-rate-'));let compared=0,refused=0;
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    // rsd_probe scores these rates 12, so they open only with -f rsd. From 2^30 Hz fftools' audio_samplerate_update finds 1 >= INT_MAX/rate and
    // rescales decoded pts through 1/28224000: the second 256-sample packet of a stereo file is not at pts 256. Copy and raw are refused with the rate.
    for(const [rate,tag] of [[1073741823,'PCM '],[1073741824,'PCMB'],[2147483647,'PCM ']] as const){
      const name=`rate-${rate}.bin`;writeFileSync(join(root,name),dump(3,tag,2,rate,32,3*1024,rate%991));
      const outputs:Output[]=[['decode.crc',['-c:a','pcm_s16le','-bitexact','-f','framecrc']],['copy.crc',['-c:a','copy','-bitexact','-f','framecrc']],['decode.raw',['-f','s16le']]];
      execFileSync(native,['-v','error','-y','-f','rsd','-i',join(root,name),...outputs.flatMap(([suffix,args])=>[...args,join(root,`native.${name}.${suffix}`)])],{timeout:60000});
      const rows=readFileSync(join(root,`native.${name}.decode.crc`),'latin1').split('\n').filter(line=>/^0,/.test(line));expect(rows.length,name).toBe(3);expect(rows[1]!.split(',')[1]!.trim()==='256',name).toBe(rate<=1073741823);
      if(rate<=1073741823){compared+=await compare(ffmpeg,root,name,['-f','rsd'],outputs);continue;}
      for(const [suffix,args] of outputs){
        const out=`/${name}.${suffix}`,result=await ffmpeg.exec(['-f','rsd','-i',`/${name}`,...args,out]);
        expect([result.exitCode,result.diagnostics.at(-1)?.message],out).toEqual([1,'RSD sample rates above 1073741823 are not implemented']);expect(existsSync(join(root,out.slice(1))),out).toBe(false);refused++;
      }
    }
    expect([compared,refused]).toEqual([3,6]);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
