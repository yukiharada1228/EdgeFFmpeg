import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const budget={maxResidentBytes:262144,maxBufferBytes:8192,maxPendingPackets:2,maxCpuTimeMs:2000};
/** "MSF" + version byte, RB32 codec, channels, size and rate, flags and padding to 0x40, then the payload; written here independently of the module. */
function msfFile(codec:number,channels:number,rate:number,payload:Uint8Array,size=payload.length):Buffer{
  const bytes=Buffer.alloc(64+payload.length,0);bytes.write('MSF\x43',0,'latin1');
  bytes.writeUInt32BE(codec,4);bytes.writeUInt32BE(channels>>>0,8);bytes.writeUInt32BE(size>>>0,12);bytes.writeUInt32BE(rate>>>0,16);bytes.writeUInt32BE(0xffffffff,20);bytes.fill(0xaa,24,64);bytes.set(payload,64);
  return bytes;
}
function random(seed:number){let state=seed>>>0||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};}
/** Noise with a ramp and a full-scale edge, so byte order and channel interleaving show in every output. */
function payload(frames:number,channels:number,seed:number):Uint8Array{
  const next=random(seed),bytes=new Uint8Array(frames*channels*2);
  for(let i=0;i<bytes.length;i+=2){const frame=i/2/channels|0;bytes[i]=frame%97===0?0x80:Math.floor(next()*256);bytes[i+1]=frame%97===0?0x00:(frame+i)&255;}
  return bytes;
}
function checkReference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.slice(0,8)).toBe('946fcce0');expect(metadata.flags).toContain('--disable-x86asm');
  expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+msf\s/);
}
/** One native run per input, every output in the same command. */
function nativeBatch(root:string,input:string,before:readonly string[],outputs:ReadonlyArray<readonly [string,readonly string[]]>):Map<string,Buffer>{
  execFileSync(native,['-v','error','-y',...before,'-i',join(root,input),...outputs.flatMap(([name,args])=>[...args,join(root,`native-${name}`)])],{timeout:60000});
  return new Map(outputs.map(([name])=>[name,readFileSync(join(root,`native-${name}`))]));
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:8192,maxWriteBytes:8192});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget})};}
const codecs=[[0,'s16be'],[1,'s16le']] as const,channelCounts=[1,2,3,6],rates=[32000,44100,48000],frameCounts=[1024,1536,700,1];
it('matches native MSF decode framecrc, copy framecrc and raw, WAV, raw and AIFF for both codecs four layouts three rates and whole or short final packets',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-msf-');
  try{
    let files=0,compared=0,copyRefused=0;
    for(const [codecId,raw] of codecs)for(const channels of channelCounts)for(const rate of rates)for(const frames of frameCounts){
      const name=`c${codecId}-${channels}-${rate}-${frames}`,whole=frames%512===0;
      writeFileSync(join(root,`${name}.msf`),msfFile(codecId,channels,rate,payload(frames,channels,codecId*1000+channels*100+frames),frames*channels*2+(frames&1?6:0)));files++;
      const outputs:Array<[string,string[]]>=[[`${name}.decode.crc`,['-c:a',`pcm_${raw}`,'-bitexact','-f','framecrc']],[`${name}.copy.crc`,['-c:a','copy','-bitexact','-f','framecrc']],[`${name}.decode.wav`,['-bitexact','-f','wav']],[`${name}.decode.raw`,['-f','s16le']],[`${name}.copy.raw`,['-c:a','copy','-f',raw]]];
      // AIFF of a guessed 3+ channel layout: native writes a CHAN chunk the shared PCM path cannot (see msf-support.md), so it is compared for 1 and 2 channels only.
      if(channels<=2)outputs.push([`${name}.decode.aiff`,['-bitexact','-f','aiff']]);
      const expected=nativeBatch(root,`${name}.msf`,[],outputs);
      for(const [out,args] of outputs){
        const result=await ffmpeg.exec(['-i',`/${name}.msf`,...args,`/${out}`]);
        if(!whole&&args.includes('copy')){
          // Native flags the short final packet KEY|CORRUPT under copy; the module refuses copy for these inputs before any output.
          if(out.endsWith('.crc'))expect(expected.get(out)!.toString('latin1').trimEnd().split('\n').at(-1),out).toMatch(/, F=0x3$/);
          expect([result.exitCode,result.diagnostics.at(-1)?.message],out).toEqual([1,'MSF stream copy of a short final packet is not implemented']);expect(existsSync(join(root,out)),out).toBe(false);copyRefused++;continue;
        }
        if(out.endsWith('.copy.crc'))expect(expected.get(out)!.toString('latin1'),out).not.toMatch(/F=0x/);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out)).equals(expected.get(out)!),out).toBe(true);compared++;
      }
    }
    expect([files,compared,copyRefused]).toEqual([96,48*6+48*5-96,96]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native MSF output -ss, -t and -frames:a timing with copy and decode, and declared -f msf',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-msf-time-');
  try{
    let compared=0;
    const profiles:ReadonlyArray<readonly string[]>=[['-ss','0.01'],['-t','0.02'],['-ss','0.005','-t','0.03'],['-frames:a','2'],['-frames:a','0'],['-t','1'],['-ss','0.0001','-frames:a','1']];
    for(const [codecId,raw] of codecs)for(const [channels,rate,frames] of [[2,44100,2560],[3,32000,1536],[6,48000,1024],[1,8000,700]] as const){
      const name=`t${codecId}-${channels}-${rate}`,whole=frames%512===0;writeFileSync(join(root,`${name}.msf`),msfFile(codecId,channels,rate,payload(frames,channels,channels+rate)));
      for(const declare of [[],['-f','msf']] as const){
        const outputs:Array<[string,string[]]>=[];
        for(const [index,profile] of profiles.entries())for(const copy of whole?[true,false]:[false])for(const [format,extra] of [['framecrc',['-bitexact']],['wav',['-bitexact']],[raw,[]]] as const){
          if(copy&&format==='wav')continue;
          outputs.push([`${name}-${declare.length}-${index}-${copy}.${format}`,[...profile,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=n=300:p=0','-c:a',format==='wav'?'pcm_s16le':`pcm_${raw}`]),...extra,'-f',format]]);
        }
        const expected=nativeBatch(root,`${name}.msf`,declare,outputs);
        for(const [out,args] of outputs){
          const result=await ffmpeg.exec([...declare,'-i',`/${name}.msf`,...args,`/${out}`]);
          expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out)).equals(expected.get(out)!),out).toBe(true);compared++;
        }
      }
    }
    expect(compared).toBe(2*2*7*(3*5+1*3));
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses unsupported MSF codecs, invalid headers, partial frames and input seeks before any output and records native statuses',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-msf-errors-');
  try{
    const data=payload(1024,2,7);
    // Native: codec 3 (adpcm_psx) opens and copies (0); codec 99 is AVERROR_PATCHWELCOME (176); zero channels (detected by
    // the .msf extension score, as the probe rejects it) and a rate above INT_MAX are AVERROR_INVALIDDATA (183); a partial
    // trailing sample is dropped by native (0); input -ss seeks natively (0).
    const cases:Array<[string,Buffer,readonly string[],number,string]>=[
      ['codec3.msf',msfFile(3,2,44100,data),[],0,'MSF codec 3 (adpcm_psx) is not implemented'],
      ['codec5.msf',msfFile(5,2,44100,data),['-f','msf'],0,'MSF codec 5 (atrac3) is not implemented'],
      ['codec7.msf',msfFile(7,2,44100,data),['-f','msf'],-1,'MSF codec 7 (mp3) is not implemented'],
      ['codec99.msf',msfFile(99,2,44100,data),[],176,'MSF codec 99 is not supported'],
      ['codec99-declared.bin',msfFile(99,2,44100,data),['-f','msf'],176,'MSF codec 99 is not supported'],
      ['channels0.msf',msfFile(0,0,44100,data),['-f','msf'],183,'Invalid MSF channel count: 0'],
      ['channels-max.msf',msfFile(0,2097151,44100,data),[],183,'Invalid MSF channel count: 2097151'],
      ['rate-negative.msf',msfFile(1,2,0x80000000,data),[],183,'Invalid MSF sample rate: 2147483648'],
      ['partial.msf',msfFile(0,2,44100,data.subarray(0,data.length-2)),[],0,'MSF partial sample frame is not implemented'],
      ['seek.msf',msfFile(0,2,44100,data),['-ss','0.001'],0,'MSF input seeking is not implemented']
    ];
    const statuses:Record<string,number|null>={};
    for(const [name,bytes,before,status,message] of cases){
      writeFileSync(join(root,name),bytes);
      const run=spawnSync(native,['-v','error','-y',...before,'-i',join(root,name),'-c:a','copy','-f','framecrc',join(root,`native-${name}.crc`)],{timeout:30000});statuses[name]=run.status;
      if(status>=0)expect(run.status,name).toBe(status);
      const result=await ffmpeg.exec([...before,'-i',`/${name}`,'-c:a','copy','-f','framecrc',`/${name}.crc`]);
      expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message,name).toBe(message);expect(result.outputs).toEqual([]);expect(existsSync(join(root,`${name}.crc`)),name).toBe(false);
      if(status===176||status===183)expect(result.exitCode,name).toBe(status);
    }
    // Zero channels fail msf_probe: undetected, native falls back to the .msf extension and fails read_header (183), while detection here is by content only.
    writeFileSync(join(root,'channels0-undeclared.msf'),msfFile(0,0,44100,data));
    expect(spawnSync(native,['-v','error','-y','-i',join(root,'channels0-undeclared.msf'),'-f','s16le',join(root,'native-c0.raw')],{timeout:30000}).status).toBe(183);
    const undetected=await ffmpeg.exec(['-i','/channels0-undeclared.msf','-f','s16le','/c0.raw']);expect(undetected.exitCode).not.toBe(0);expect(undetected.diagnostics.at(-1)?.message).toBe('Unsupported audio container signature');expect(existsSync(join(root,'c0.raw'))).toBe(false);
    // msf is demux-only in native and here.
    expect(spawnSync(native,['-v','error','-y','-f','s16le','-i',join(root,'partial.msf'),'-f','msf',join(root,'out.msf')],{timeout:30000}).status).not.toBe(0);
    const mux=await ffmpeg.exec(['-f','s16le','-i','/partial.msf','-f','msf','/out.msf']);expect(mux.exitCode).not.toBe(0);expect(mux.diagnostics.at(-1)?.message).toMatch(/^Output requires /);expect(existsSync(join(root,'out.msf'))).toBe(false);
    expect(Object.keys(statuses)).toHaveLength(10);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native MSF unlabelled 3 and 6 channel layouts under -guess_layout_max 0 and 2, including AIFF where nothing is guessed',async()=>{
  checkReference();const {root,ffmpeg}=await setup('edgeffmpeg-msf-guess-');
  try{
    let compared=0;
    for(const channels of [3,6]){
      const name=`g${channels}`;writeFileSync(join(root,`${name}.msf`),msfFile(1,channels,48000,payload(1024,channels,channels)));
      for(const guess of ['0','2']){
        const outputs:Array<[string,string[]]>=[[`${name}-${guess}.wav`,['-bitexact','-f','wav']],[`${name}-${guess}.w64`,['-bitexact','-f','w64']],[`${name}-${guess}.au`,['-bitexact','-f','au']],[`${name}-${guess}.copy.crc`,['-c:a','copy','-bitexact','-f','framecrc']],[`${name}-${guess}.crc`,['-bitexact','-f','framecrc']],[`${name}-${guess}.aiff`,['-bitexact','-f','aiff']]];
        const expected=nativeBatch(root,`${name}.msf`,['-guess_layout_max',guess],outputs);
        for(const [out,args] of outputs){
          const result=await ffmpeg.exec(['-guess_layout_max',guess,'-i',`/${name}.msf`,...args,`/${out}`]);
          expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out)).equals(expected.get(out)!),out).toBe(true);compared++;
        }
      }
    }
    expect(compared).toBe(24);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
