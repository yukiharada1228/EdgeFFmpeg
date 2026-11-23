import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseVideoSize} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
it('matches all pinned native named input sizes and LP64 numeric size syntax with complete framecrc outputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-size-'));
 try{
  const table=readFileSync('upstream/ffmpeg/libavutil/parseutils.c','utf8').split('static const VideoSizeAbbr video_size_abbrs[] = {')[1]!.split('};')[0]!,names=[...table.matchAll(/\{ "([^"]+)",\s*(\d+),\s*(\d+)\s*\}/g)];expect(names.length).toBe(55);
  const inputs=[...names.map(m=>m[1]!), '2X3','2:3','2/3','2 3','  +002x+03','4294967298x3','-4294967294x3'];
  writeFileSync(join(root,'empty.raw'),new Uint8Array());
  for(const size of inputs){
   const before=['-f','rawvideo','-pixel_format','gray','-video_size',size],after=['-frames:v','0','-bitexact','-f','framecrc'],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'empty.raw'),...after,'-']),sink=collectingOutput();
   const edge=new FFmpeg({filesystem:{async openRead(){return {size:0n,async readAt(){throw new Error('Unexpected empty read');}};},async openWrite(){return sink.output;}},backend:createMediaBackend(),budget:{maxResidentBytes:1024*1024*1024,maxBufferBytes:64*1024*1024,maxPendingPackets:2,maxCpuTimeMs:10000}});
   expect((await edge.exec([...before,'-i','/empty.raw',...after,'/out'])).exitCode,size).toBe(0);expect(Buffer.from(sink.bytes()),size).toEqual(native);
  }
  for(const m of names)expect(parseVideoSize(m[1]!)).toEqual({width:Number(m[2]),height:Number(m[3])});
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('matches named output resizing and rejects malformed input and output sizes before opening files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-size-output-')),data=Uint8Array.from({length:6},(_,i)=>i*41);
 try{
  writeFileSync(join(root,'input.raw'),data);
  for(const size of ['sqcif','qqvga','qcif','2:3','4294967298x3']){
   const before=['-f','rawvideo','-pixel_format','gray','-s','2x3'],after=['-s',size,'-bitexact','-f','framecrc'],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
   const edge=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+Math.min(length,2));}};},async openWrite(){return sink.output;}},backend:createMediaBackend(),budget:{maxResidentBytes:4*1024*1024,maxBufferBytes:1024*1024,maxPendingPackets:2,maxCpuTimeMs:10000}});
   expect((await edge.exec([...before,'-i','/input.raw',...after,'/out'])).exitCode,size).toBe(0);expect(Buffer.from(sink.bytes()),size).toEqual(native);
  }
  for(const size of ['PAL','2xx3','2x3 ','2x3\n','0x3','-1x3','9223372036854775808x3'])for(const output of [false,true]){
   let opens=0;const edge=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected open');},async openWrite(){opens++;throw new Error('Unexpected open');}},backend:createMediaBackend()});
   const before=['-f','rawvideo','-pixel_format','gray','-s',output?'2x3':size],after=[...(output?['-s',size]:[]),'-bitexact','-f','framecrc'];
   expect(()=>execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-'],{stdio:'pipe'})).toThrow();
   const result=await edge.exec([...before,'-i','/input.raw',...after,'/out']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe('invalid-arguments');expect(opens).toBe(0);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
