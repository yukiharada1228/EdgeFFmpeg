import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native replayed negate branches and joins frame by frame',async()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-negate-stream-'));let checked=0;
 try{
  for(const [source,target]of [['yuva420p','yuva420p'],['nv12','rgba'],['bgra','gray'],['gbrp',null]] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=Uint8Array.from({length:frameBytes*3},(_,i)=>(i*53+17)&255),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]negate[out]','[in]negate=negate_alpha=1,hflip[out]','[in]split[x][y];[x]negate[l];[y]negate=components=none[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,negate[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(resolve('.build/reference/ffmpeg'),['-y','-v','error','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(16);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
