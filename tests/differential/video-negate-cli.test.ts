import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const frontendFor=(input:Uint8Array,arithmetic:ReturnType<typeof referencePixelArithmetic>,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,11));}};},async openWrite(path){return open(path);}},backend:createMediaBackend({pixelArithmetic:arithmetic}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000}});
it('matches native negate CLI outputs across negotiated formats timing and size scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-negate-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const [source,target]of [['rgba','nv12'],['nv21','bgra'],['yuv444p','gbrp'],['gray','yuva420p'],['gbrp','gray'],['bgr24','rgba'],['yuva420p','rgb24'],['nv12',null]] as const){
   const input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*4},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),input);
   for(const description of ['negate','negate=negate_alpha=1','hflip,negate,scale=13:7','format=nv12,negate,vflip'])for(const size of [null,'3x2'])for(const format of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of [[[],[]],[['-ss','0.02'],['-t','0.05']],[[],['-ss','0.02','-frames:v','1']]]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','5x3',...inputTime!],after=['-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),...outputTime!,'-bitexact','-f',format],native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontendFor(input,arithmetic,()=>sink.output).exec([...before,'-i','/in',...after,'/out']);expect(result.exitCode,JSON.stringify({source,target,description,size,format,result})).toBe(0);expect(Buffer.from(sink.bytes()),`${source}/${target}/${description}/${size}/${format}/${inputTime}/${outputTime}`).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(384);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native complex negate branches across mapping and output scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-negate-complex-')),arithmetic=referencePixelArithmetic();let cases=0;
 try{
  for(const [source,left,right]of [['rgba','nv12','gray'],['nv21','bgra','rgba'],['yuva420p','yuva420p','gbrp'],['gray','rgb24','yuv422p']] as const){
   const input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*3},(_,i)=>(i*41+5)&255),file=join(root,'input.raw');writeFileSync(file,input);
   for(const description of ['[0:v]split[a][b];[a]negate[left];[b]hflip,negate=negate_alpha=1[right]','[0:v]negate,split[left][right]','[0:v]format=nv12,split[a][b];[a]negate=negate_alpha=1[left];[b]transpose=clock,negate[right]'])for(const format of ['rawvideo','framecrc'])for(const time of [[],['-ss','0.02','-frames:v','1']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],outputs=(prefix:string)=>[['left',left],['right',right]].flatMap(([label,target],index)=>['-map',`[${label}]`,'-pix_fmt',target!,...time,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(resolve('.build/reference/ffmpeg'),['-y','-v','error',...before,'-i',file,'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontendFor(input,arithmetic,path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);expect(result.exitCode,JSON.stringify({source,description,format,time,result})).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed).toBe(true);expect(Buffer.from(sink.bytes()),`${source}/${description}/${format}/${time}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}cases++;
   }
  }
  expect(cases).toBe(48);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for unavailable negate components before opening CLI outputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-negate-reject-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  // After a semiplanar conversion boundary, negate merges with the RGB sink constraint and loses chroma components.
  for(const [source,description,complex,targets]of [['rgb24','negate=a',false,[]],['gray','negate=u',false,[]],['yuv444p','negate=r',false,[]],['gbrp','negate=y',false,[]],['rgba','format=rgb24,negate=a',false,[]],['rgba','[0:v]split[a][b];[a]negate=a[left];[b]format=rgb24,negate=a[right]',true,[]],['nv21','[0:v]format=nv12,split[a][b];[a]negate=u[left];[b]negate[right]',true,['-pix_fmt','bgra']]] as const){
   const input=Uint8Array.from({length:pixelLayout(source,5,3).bytes*2},(_,i)=>i&255);writeFileSync(join(root,'input.raw'),input);
   const before=['-f','rawvideo','-pixel_format',source,'-s','5x3'],after=complex?['-filter_complex',description,'-map','[left]',...targets,'-f','rawvideo','OUT0','-map','[right]','-f','rawvideo','OUT1']:['-vf',description,...targets,'-f','rawvideo','OUT0'];
   const native=spawnSync(resolve('.build/reference/ffmpeg'),['-y','-v','error',...before,'-i',join(root,'input.raw'),...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,description).not.toBe(0);expect(native.stderr.toString(),description).toContain('Requested components not available');
   let opened=0;const result=await frontendFor(input,arithmetic,()=>{opened++;return collectingOutput().output;}).exec([...before,'-i','/in',...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
   expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);count++;
  }
  expect(count).toBe(7);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
