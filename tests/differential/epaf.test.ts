import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
// Header layout from libavformat/epafdec.c: magic, zero word, LE flag (always little-endian), rate, codec, channels; data at 2048.
function paf(le:boolean,codec:number,channels:number,rate:number,payload:Uint8Array):Uint8Array{
  const bytes=new Uint8Array(2048+payload.length),view=new DataView(bytes.buffer);
  bytes.set([...(le?'fap ':' paf')].map(c=>c.charCodeAt(0)));view.setUint32(8,le?1:0,true);view.setInt32(12,rate,le);view.setInt32(16,codec,le);view.setInt32(20,channels,le);
  for(let i=24;i<2048;i++)bytes[i]=(i*29)&255;bytes.set(payload,2048);return bytes;
}
const payload=(length:number)=>Uint8Array.from({length},(_,i)=>(i*131+7)&255);
const budget={maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:2000};
it('matches native copy framecrc WAV AIFF and raw output for LE/BE files, codecs 0 and 2, 1/2/6 channels and three rates',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-epaf-'));let comparisons=0;
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    for(const le of [true,false])for(const codec of [0,2])for(const channels of [1,2,6])for(const rate of [8000,44100,96000]){
      const width=codec===2?1:2,frames=rate===8000?1031:4097,name=`${le?'le':'be'}-${codec}-${channels}-${rate}`,raw=codec===2?'s8':le?'s16le':'s16be';
      writeFileSync(join(root,`${name}.paf`),paf(le,codec,channels,rate,payload(frames*channels*width)));
      for(const [index,[declare,tail,extension]] of ([
        [false,['-c:a','copy','-f','framecrc'],'crc'],[true,['-c:a','copy','-f','framecrc'],'crc'],
        [false,['-f','wav'],'wav'],[false,['-f','aiff'],'aiff'],[false,['-c:a','copy','-f',raw],'raw'],[false,['-f','s16le'],'raw']
      ] as const).entries()){
        // Native guesses 5.1 for 6 unlabelled channels and writes an MPEG_5_1_A CHAN chunk; the shared PCM path passes no mask to the AIFF muxer, so guessed-layout AIFF is outside this comparison.
        if(extension==='aiff'&&channels>2)continue;
        const before=['-cpuflags','0',...(declare?['-f','epaf']:[])],after=[...tail,'-bitexact'],out=`${name}-${index}.${extension}`;
        // Native writes to a seekable file so WAV and AIFF headers carry final sizes.
        execFileSync(native,['-v','error','-y',...before,'-i',join(root,`${name}.paf`),...after,join(root,`native-${out}`)]);const expected=readFileSync(join(root,`native-${out}`));
        const result=await ffmpeg.exec([...before,'-i',`/${name}.paf`,...after,`/${out}`]);expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
        expect(readFileSync(join(root,out)).equals(expected),out).toBe(true);comparisons++;
      }
    }
    expect(comparisons).toBe(204);
  }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native packet timing under input and output -ss/-t, -frames and filtered decode',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-epaf-time-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    for(const [le,codec] of [[true,0],[false,0],[true,2],[false,2]] as const){
      const name=`${le?'le':'be'}-${codec}`;writeFileSync(join(root,`${name}.paf`),paf(le,codec,2,8000,payload(4301*2*(codec===2?1:2))));
      const profiles=[{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:['-ss','0.25'],after:['-t','0.1']},{before:[],after:['-t','0.3']},{before:[],after:['-frames:a','2']},{before:['-ss','0.5375'],after:[]}];
      for(const [index,profile] of profiles.entries())for(const copy of [true,false]){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1','-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],out=`${name}-${index}-${copy}.crc`;
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,`${name}.paf`),...after,'-']),result=await ffmpeg.exec([...before,'-i',`/${name}.paf`,...after,`/${out}`]);
        expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out)).equals(expected),out).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native layout guessing for 6 unlabelled channels under -guess_layout_max',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-epaf-layout-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    writeFileSync(join(root,'six.paf'),paf(false,0,6,44100,payload(301*12)));
    for(const guess of [[],['-guess_layout_max','2'],['-guess_layout_max','0']])for(const [index,tail] of [['-f','wav'],['-f','w64'],['-f','au'],['-c:a','copy','-f','framecrc'],['-f','framecrc'],...(guess.length?[['-f','aiff']]:[])].entries()){
      const out=`six-${guess.join('')}-${index}.out`;execFileSync(native,['-v','error','-y',...guess,'-i',join(root,'six.paf'),...tail,'-bitexact',join(root,`native-${out}`)]);
      const result=await ffmpeg.exec([...guess,'-i','/six.paf',...tail,'-bitexact',`/${out}`]);expect(result.exitCode,`${out} ${JSON.stringify(result.diagnostics)}`).toBe(0);
      expect(readFileSync(join(root,out)).equals(readFileSync(join(root,`native-${out}`))),out).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('refuses with native exit codes for invalid fields and short headers and refuses partial frames before any output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-epaf-refuse-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    const cases:Array<[string,Uint8Array,number|null]>=[
      ['codec1',paf(true,1,2,8000,payload(400)),183],['codec3',paf(false,3,2,8000,payload(400)),183],
      ['channels0',paf(true,0,0,8000,payload(400)),183],['channels513',paf(false,0,513,8000,payload(2052)),183],['rate-negative',paf(true,0,2,-8000,payload(400)),183],
      // Native fails its 2024-byte skip on a short file and decodes a partial trailing frame with a decoder error and exit 0, which the module refuses explicitly.
      ['truncated',paf(true,0,2,8000,new Uint8Array(0)).subarray(0,1000),183],['truncated-fields',paf(true,0,2,8000,new Uint8Array(0)).subarray(0,23),183],['partial',paf(true,0,2,8000,payload(401)),null]
    ];
    // A header with no payload is a valid zero-sample input.
    writeFileSync(join(root,'empty.paf'),paf(true,2,1,8000,new Uint8Array(0)));
    for(const tail of [['-f','wav'],['-c:a','copy','-f','framecrc']]){
      execFileSync(native,['-v','error','-y','-i',join(root,'empty.paf'),...tail,'-bitexact',join(root,'empty-native.out')]);
      const result=await ffmpeg.exec(['-y','-i','/empty.paf',...tail,'-bitexact','/empty.out']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,'empty.out'))).toEqual(readFileSync(join(root,'empty-native.out')));
    }
    for(const [name,bytes,status] of cases)for(const declare of [false,true]){
      writeFileSync(join(root,`${name}.paf`),bytes);const before=declare?['-f','epaf']:[];
      const reference=spawnSync(native,['-v','error',...before,'-i',join(root,`${name}.paf`),'-f','wav',join(root,`${name}-native.wav`)]);
      const result=await ffmpeg.exec([...before,'-i',`/${name}.paf`,'-f','wav',`/${name}-${declare}.wav`]);
      if(status===null){expect(reference.status,name).toBe(0);expect(result.exitCode,name).not.toBe(0);}
      // A zero channel word or a file shorter than 24 bytes fails epaf_probe, so undeclared native detection fails with INVALIDDATA while the shared detector reports an unknown signature.
      else if((name==='channels0'||name==='truncated-fields')&&!declare){expect([reference.status,result.exitCode,result.diagnostics.at(-1)?.message]).toEqual([status,1,'Unsupported audio container signature']);}
      else{expect([reference.status,result.exitCode],`${name}/${declare}`).toEqual([status,status]);}
      expect(existsSync(join(root,`${name}-${declare}.wav`)),name).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
