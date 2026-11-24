import {describe,expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const formats=[['u8',1],['s16le',2],['s32le',4],['f32le',4]] as const;
const names:Record<number,readonly string[]>={1:['FC'],2:['FL','FR'],3:['FL','FR','LFE']};
/** Every tuple of `length` values below `count`: each permutation and duplication. */
const tuples=(count:number,length:number):number[][]=>length===0?[[]]:tuples(count,length-1).flatMap(rest=>Array.from({length:count},(_,value)=>[...rest,value]));
const permutations=(count:number)=>tuples(count,count).filter(tuple=>new Set(tuple).size===count);
/** Every accepted map for `channels`: indices, names, both pair kinds with index and name outputs (each output permutation with every input tuple), trailing separator, keyed and channel_layout forms. */
function maps(channels:number):string[]{
  const label=names[channels]!,layout=['mono','stereo','2.1'][channels-1]!,result:string[]=[];
  for(const tuple of tuples(channels,channels)){
    result.push(tuple.join('|'),tuple.map(index=>label[index]).join('|'));
    for(const outputs of permutations(channels))for(const [input,output] of [[String,String],[String,(index:number)=>label[index]!],[(index:number)=>label[index]!,String],[(index:number)=>label[index]!,(index:number)=>label[index]!]] as const)
      result.push(tuple.map((index,at)=>`${input(index)}-${output(outputs[at]!)}`).join('|'));
  }
  const reversed=Array.from({length:channels},(_,index)=>channels-1-index);
  result.push(`${reversed.join('|')}|`,`map=${reversed.join('|')}`,`${reversed.join('|')}:${layout}`,`map=${reversed.map(index=>label[index]).join('|')}:channel_layout=${layout}`,`channel_layout=${layout}`,`${reversed.map((index,at)=>`${index}-${at}`).join('|')}|`);
  return result;
}
function fixture(raw:string,width:number,channels:number,samples=97){
  const data=Uint8Array.from({length:samples*channels*width},(_,i)=>(i*37+13+(i%channels)*101)&255),view=new DataView(data.buffer);
  if(raw.startsWith('f'))for(let i=0;i<samples*channels;i++){const value=Math.sin(i*.123+(i%channels))+.3*Math.cos(i*.49);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
  return data;
}
async function harness(prefix:string){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536});
  const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:1000}});
  return {root,frontend};
}
/** Input args, filter args; compares the CLI output bytes with native's. */
async function compare(context:{root:string;frontend:FFmpeg},input:readonly string[],output:readonly string[],out:string,label:string){
  // Native writes a seekable file, so WAV and W64 sizes are patched as the CLI patches them.
  const reference=join(context.root,`native${out.slice(1)}`);execFileSync(native,['-v','error','-y',...input.map(arg=>arg==='/input'?join(context.root,'input'):arg),...output,reference]);const expected=readFileSync(reference);
  const result=await context.frontend.exec([...input,...output,out]);
  expect(result.exitCode,`${label} ${JSON.stringify(result.diagnostics)}`).toBe(0);
  expect(readFileSync(join(context.root,out.slice(1))).equals(expected),label).toBe(true);
  return expected;
}
describe('channelmap against native',()=>{
 it('matches native raw bytes for every permutation and duplication in each accepted syntax, u8/s16/s32/f32 with 1-3 channels',async()=>{
  const context=await harness('edgeffmpeg-channelmap-raw-');let index=0,compared=0;
  try{
   for(const [raw,width] of formats)for(const channels of [1,2,3]){
    writeFileSync(join(context.root,'input'),fixture(raw,width,channels));
    for(const map of maps(channels)){await compare(context,['-f',raw,'-ar','8000','-ac',String(channels),'-i','/input'],['-af',`channelmap=${map}`,'-f',raw],`/${index++}.raw`,`${raw} ${channels} ${map}`);compared++;}
   }
   // Per format: mono 1x(2+1x4)+6, stereo 4x(2+2x4)+6, three channels 27x(2+6x4)+6.
   expect(compared).toBe(4*(12+46+708));
  }finally{rmSync(context.root,{recursive:true,force:true});}
 },600000);
 it('matches native framecrc, WAV and W64 headers and bytes, composed chains and output time selection',async()=>{
  const context=await harness('edgeffmpeg-channelmap-mux-');let index=0;
  try{
   for(const [raw,width] of formats)for(const channels of [1,2,3]){
    writeFileSync(join(context.root,'input'),fixture(raw,width,channels,301));
    const map=Array.from({length:channels},(_,at)=>(at+1)%channels).join('|'),input=['-f',raw,'-ar','8000','-ac',String(channels),'-i','/input'],codec=`pcm_${raw}`;
    const crc=await compare(context,input,['-af',`channelmap=${map}`,'-c:a',codec,'-bitexact','-f','framecrc'],`/${index++}.crc`,`${raw} ${channels} framecrc`);
    expect(crc.toString(),`${raw} ${channels}`).toContain(`#channel_layout_name 0: ${['mono','stereo','2.1'][channels-1]}`);
    for(const muxer of ['wav','w64'])await compare(context,input,['-af',`channelmap=${map}`,'-c:a',codec,'-bitexact','-f',muxer],`/${index++}.${muxer}`,`${raw} ${channels} ${muxer}`);
    for(const filter of [`asetnsamples=7:p=1,channelmap=${map}`,`channelmap=${map},asetnsamples=5:p=1`,`channelmap=${map},channelmap=${map}`,`apad=pad_len=9,channelmap=${map}`])
     await compare(context,input,['-af',filter,'-c:a',codec,'-bitexact','-f','framecrc'],`/${index++}.crc`,`${raw} ${channels} ${filter}`);
    for(const selection of [['-ss','0.003','-t','0.01'],['-frames:a','1']])await compare(context,input,['-af',`asetnsamples=11:p=1,channelmap=${map}`,...selection,'-f',raw],`/${index++}.raw`,`${raw} ${channels} ${selection.join(' ')}`);
   }
   // Double samples reach channelmap only through an explicit planar double format, where native keeps dblp instead of picking s64p.
   writeFileSync(join(context.root,'input'),fixture('f64le',8,2,301));
   for(const filter of ['aformat=f=dblp,channelmap=1|0','aformat=f=dblp,channelmap=0|0,aformat=f=dbl'])
    await compare(context,['-f','f64le','-ar','8000','-ac','2','-i','/input'],['-af',filter,'-f','f64le'],`/${index++}.raw`,filter);
  }finally{rmSync(context.root,{recursive:true,force:true});}
 },120000);
 it('refuses out-of-scope maps, double input and non-default WAV masks before output, with native status recorded',async()=>{
  const context=await harness('edgeffmpeg-channelmap-refuse-');let index=0;
  try{
   const cases:readonly (readonly [string,number,string,string,number])[]=[
    // [raw format, channels, filter, our message, native exit status]
    ['s16le',2,'channelmap=0','channelmap output layout mono differs from input layout stereo, which is not implemented',0],
    ['s16le',1,'channelmap=0|0','channelmap output layout stereo differs from input layout mono, which is not implemented',0],
    ['f64le',2,'channelmap=1|0','channelmap with dbl input negotiates s64p, which is not implemented',0],
    ['s16le',2,'channelmap=XX|FL','Failed to parse channel map',234],
    ['s16le',2,'channelmap=1|0:channel_layout=mono','Output channel layout mono does not match the number of channels mapped 2.',234],
    ['s16le',2,'channelmap=FC-FL|FL-FR',"Input channel 'FC' not available from input layout 'stereo'",234],
    ['s16le',2,'channelmap=0|2','Input channel #2 not available from input layout \'stereo\'',234],
    ['s16le',2,'channelmap','Output channel layout is not set and cannot be guessed from the maps.',234],
    ['s16le',3,'channelmap=0|1','channelmap output layout stereo differs from input layout 2.1, which is not implemented',0],
    ['s16le',2,'channelmap=FL-FC|FR-FL','channelmap output layout 2 channels (FL+FC) differs from input layout stereo, which is not implemented',0]
   ];
   for(const [raw,channels,filter,message,status] of cases){
    writeFileSync(join(context.root,'input'),fixture(raw,raw==='f64le'?8:2,channels));
    const input=['-f',raw,'-ar','8000','-ac',String(channels),'-i','/input'],output=['-af',filter,'-f',raw];
    expect(spawnSync(native,['-v','error',...input.map(arg=>arg==='/input'?join(context.root,'input'):arg),...output,'-']).status,filter).toBe(status);
    const out=`/${index++}.raw`,result=await context.frontend.exec([...input,...output,out]);
    expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics[0]?.message,filter).toBe(message);expect(existsSync(join(context.root,out.slice(1))),filter).toBe(false);
   }
   // A two-channel WAV with a non-default WAVEFORMATEXTENSIBLE mask: refused before output; the default mask runs and matches native.
   for(const [mask,status] of [[0x5,0],[0x60000000,0],[0x3,0]] as const){
    writeFileSync(join(context.root,'input'),extensibleWav(2,mask));
    const input=['-i','/input'],output=['-af','channelmap=1|0','-f','s16le'];
    const nativeRun=spawnSync(native,['-v','error','-i',join(context.root,'input'),...output,'-']);expect(nativeRun.status,`mask ${mask}`).toBe(status);
    if(mask===0x3){await compare(context,input,output,`/${index++}.raw`,'default mask');continue;}
    const out=`/${index++}.raw`,result=await context.frontend.exec([...input,...output,out]);
    expect(result.exitCode,`mask ${mask}`).not.toBe(0);expect(result.diagnostics[0]?.message).toBe('channelmap requires the default channel layout for its input channel count');expect(existsSync(join(context.root,out.slice(1)))).toBe(false);
   }
  }finally{rmSync(context.root,{recursive:true,force:true});}
 },60000);
});
/** 2-channel s16 8000 Hz WAV of 64 samples: WAVEFORMATEXTENSIBLE with `mask`. */
function extensibleWav(channels:number,mask:number):Uint8Array{
 const payload=fixture('s16le',2,channels,64),fmt=40,bytes=new Uint8Array(28+fmt+payload.length),out=new DataView(bytes.buffer),text=(at:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[at+index]=value.charCodeAt(index);};
 text(0,'RIFF');out.setUint32(4,20+fmt+payload.length,true);text(8,'WAVE');text(12,'fmt ');out.setUint32(16,fmt,true);
 out.setUint16(20,0xfffe,true);out.setUint16(22,channels,true);out.setUint32(24,8000,true);out.setUint32(28,8000*channels*2,true);out.setUint16(32,channels*2,true);out.setUint16(34,16,true);
 out.setUint16(36,22,true);out.setUint16(38,16,true);out.setUint32(40,mask>>>0,true);bytes.set([1,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],44);
 text(20+fmt,'data');out.setUint32(24+fmt,payload.length,true);bytes.set(payload,28+fmt);
 return bytes;
}
