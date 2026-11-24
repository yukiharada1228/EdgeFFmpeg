import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
// libavformat/avr.c layout: '2BIT', 8-byte name, u16be chan, bps, sign, loop, midi, u8 replay speed, u24be rate, then 102 bytes to the 128-byte data start.
function avr(chan:number,bps:number,sign:number,rate:number,payload:number,seed=1):Uint8Array{
  const bytes=new Uint8Array(128+payload),view=new DataView(bytes.buffer);bytes.set([0x32,0x42,0x49,0x54]);bytes.set([...'edgetest'].map(c=>c.charCodeAt(0)),4);
  view.setUint16(12,chan,false);view.setUint16(14,bps,false);view.setUint16(16,sign,false);view.setUint16(20,0xffff,false);bytes.set([rate>>16&255,rate>>8&255,rate&255],23);
  for(let i=0;i<payload;i++)bytes[128+i]=(i*(37+seed)+11*seed)&255;
  return bytes;
}
async function setup(prefix:string){const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});return {root,ffmpeg:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000}})};}
const run=(args:string[])=>spawnSync(native,['-v','error',...args],{maxBuffer:1<<26});
it('matches native AVR stream copy framecrc and s16le decode for sign masks widths channels rates and odd lengths',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-avr-');let compared=0;
  try{
    for(const bps of [8,16,24,32])for(const sign of [0,0xffff,1<<(bps/8-1),0xffff^(1<<(bps/8-1))])for(const chan of [0,0xffff])for(const rate of [8000,22050,96000]){
      const channels=chan?2:1,frames=rate===96000?9601:rate===22050?2207:1023,name=`${bps}-${sign}-${chan}-${rate}`,path=join(root,`${name}.avr`);
      writeFileSync(path,avr(chan,bps,sign,rate,frames*channels*bps/8,bps+rate));
      const codec=`pcm_${sign&(1<<(bps/8-1))?'s':'u'}${bps}${bps>8?'be':''}`;
      for(const declared of [[],['-f','avr']]){
        const expected=run([...declared,'-i',path,'-c:a','copy','-bitexact','-f','framecrc','-']);expect(expected.status).toBe(0);
        const header=expected.stdout.toString();
        // Native scores AVR at 25; claim autodetection only where its framecrc header shows the AVR stream.
        if(!header.includes(`#codec_id 0: ${codec}\n`)||!header.includes(`#sample_rate 0: ${rate}\n`)||!header.includes(`#channel_layout_name 0: ${channels===1?'mono':'stereo'}\n`))throw new Error(`native did not demux ${name} as AVR: ${header.slice(0,300)}`);
        const out=`/${name}-${declared.length}.crc`,result=await ffmpeg.exec([...declared,'-i',`/${name}.avr`,'-c:a','copy','-bitexact','-f','framecrc',out]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/copy/${declared.length}`).toBe(true);compared++;
      }
      const decoded=run(['-cpuflags','0','-i',path,'-f','s16le','-']);expect(decoded.status).toBe(0);
      const result=await ffmpeg.exec(['-cpuflags','0','-i',`/${name}.avr`,'-f','s16le',`/${name}.raw`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      expect(readFileSync(join(root,`${name}.raw`)).equals(decoded.stdout),`${name}/s16le`).toBe(true);compared++;
    }
    expect(compared).toBe(288);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native AVR WAV decode and seek duration selections with and without -f avr',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-avr-time-');
  try{
    for(const [chan,bps,sign] of [[0,8,0],[0xffff,16,0xffff],[0,24,4],[0xffff,32,0]] as const){
      const channels=chan?2:1,name=`${bps}-${chan}`,path=join(root,`${name}.avr`);writeFileSync(path,avr(chan,bps,sign,22050,4411*channels*bps/8,bps));
      for(const declared of [[],['-f','avr']]){
        const wavPath=join(root,`${name}-${declared.length}-native.wav`),wav=run([...declared,'-i',path,'-bitexact','-f','wav',wavPath]);expect(wav.status).toBe(0);
        const result=await ffmpeg.exec([...declared,'-i',`/${name}.avr`,'-bitexact','-f','wav',`/${name}-${declared.length}.wav`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        expect(readFileSync(join(root,`${name}-${declared.length}.wav`)).equals(readFileSync(wavPath)),`${name}/wav`).toBe(true);
        const profiles=[{before:['-ss','0.05'],after:[]},{before:[],after:['-ss','0.01','-t','0.1']},{before:['-ss','0.02'],after:['-t','0.0333']},{before:[],after:['-frames:a','2']}];
        for(const [index,profile] of profiles.entries())for(const copy of [true,false]){
          const tail=[...profile.after,...(copy?['-c:a','copy']:['-c:a','pcm_s16le']),'-bitexact','-f','framecrc'],expected=run(['-cpuflags','0',...declared,...profile.before,'-i',path,...tail,'-']);expect(expected.status).toBe(0);
          const out=`/${name}-${declared.length}-${index}-${copy}.crc`,timed=await ffmpeg.exec(['-cpuflags','0',...declared,...profile.before,'-i',`/${name}.avr`,...tail,out]);expect(timed.exitCode,JSON.stringify(timed.diagnostics)).toBe(0);
          expect(readFileSync(join(root,out.slice(1))).equals(expected.stdout),`${name}/${index}/${copy}`).toBe(true);
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses AVR chan, rate, unmapped bps, unported bps and partial trailing frames before any output',async()=>{
  const {root,ffmpeg}=await setup('edgeffmpeg-avr-refuse-');
  try{
    // [label, chan, bps, sign, rate, payload bytes, native exit status]: 176 AVERROR_PATCHWELCOME, 183 AVERROR_INVALIDDATA.
    const mirrored=[['chan2',2,16,0xffff,8000,64,176],['rate0',0,16,0xffff,0,64,183],['bps0',0,0,0,8000,64,176],['bps40',0,40,0xffff,8000,64,176],['bps64u',0,64,0,8000,64,176],['bps65',0,65,0xffff,8000,64,176]] as const;
    for(const [label,chan,bps,sign,rate,payload,status] of mirrored){
      writeFileSync(join(root,`${label}.avr`),avr(chan,bps,sign,rate,payload));
      for(const declared of [[],['-f','avr']]){
        const expected=run([...declared,'-i',join(root,`${label}.avr`),'-f','s16le','-']);expect(expected.status,label).toBe(status);
        const result=await ffmpeg.exec([...declared,'-i',`/${label}.avr`,'-f','s16le',`/${label}.raw`]);expect(result.exitCode,label).toBe(status);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
      }
    }
    // Native accepts these (bps 12 as s16be with a 1-byte block_align, bps 64 as pcm_s64be, a short final packet); the port refuses them explicitly.
    const unported=[['bps12',0,12,0xffff,8000,64,/bps 12/],['bps4',0,4,0,8000,64,/bps 4/],['bps64s',0,64,0xffff,8000,64,/bps 64/],['partial',0xffff,16,0xffff,8000,66,/partial trailing/]] as const;
    for(const [label,chan,bps,sign,rate,payload,message] of unported){
      writeFileSync(join(root,`${label}.avr`),avr(chan,bps,sign,rate,payload));
      expect(execFileSync(native,['-v','quiet','-i',join(root,`${label}.avr`),'-c','copy','-f','framecrc','-']).length,label).toBeGreaterThan(0);
      const result=await ffmpeg.exec(['-i',`/${label}.avr`,'-f','s16le',`/${label}.raw`]);expect(result.exitCode,label).not.toBe(0);expect(JSON.stringify(result.diagnostics),label).toMatch(message);expect(existsSync(join(root,`${label}.raw`))).toBe(false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
