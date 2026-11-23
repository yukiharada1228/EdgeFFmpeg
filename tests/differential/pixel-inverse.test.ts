import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const sourceFormats=['yuv420p','yuva420p','nv12','nv21','yuv422p'],destinations=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'];
async function compare(profile:PixelArithmetic,geometries:readonly (readonly [number,number])[],timing:boolean,nativeDefault=false){
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pixel-inverse-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536}),frontend=new FFmpeg({filesystem,backend:createMediaBackend({pixelArithmetic:profile}),budget:{maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000}});let index=0;
  for(const source of sourceFormats)for(const destination of destinations)for(const [width,height]of geometries){
   if(profile==='aarch64'&&['nv12','nv21'].includes(source)&&width%16===0&&height%2===0)continue;
   const layout=pixelLayout(source,width,height);let seed=53;writeFileSync(join(root,'input.raw'),Uint8Array.from({length:layout.bytes*2},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}));
   for(const selection of timing?[[],['-ss','0.02','-t','0.05']]:[[]])for(const format of ['rawvideo','framecrc']){
    const before=[...(!nativeDefault&&profile==='scalar'?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-pix_fmt',destination,...selection,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${profile}/${source}/${destination}/${width}x${height}/${selection}/${format}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.equals(expected),`${label}: mismatch ${actual.findIndex((value,i)=>value!==expected[i])}, expected ${expected.subarray(0,50).toString('hex')}, actual ${actual.subarray(0,50).toString('hex')}`).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
}
it('matches native default subsampled YUV to RGB interpolation and recorded platform arithmetic dispatch',async()=>{
 await compare(referencePixelArithmetic(),[[1,1],[2,2],[3,2],[3,3],[5,3],[6,4],[8,6],[16,6],[17,9],[32,8],[33,32],[127,65],[5,7],[16,7],[16,5],[6,7]],true,true);
},180000);
it('matches explicit native scalar subsampled YUV to RGB and cpuflags zero independently of default NEON arithmetic',async()=>{
 await compare('scalar',[[1,1],[3,2],[5,3],[16,6],[17,9],[32,8],[5,7],[16,7]],false);
},60000);

it('records pinned native aligned NV12 NV21 output instability and rejects the unverified default path before I/O',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/inverse-native-instability.json','utf8')) as {upstreamCommit:string;referenceBinarySha256:string;platform:string;arch:string;input:{sha256:string};observations:{source:string;options:string[];repeats:number;outputHashes:Record<string,number>}[]};
 const reference=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;platform:string;arch:string;flags:string[];artifacts:{ffmpeg:string}};
 const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string;configureFile:string};
 const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex'),binarySha256=hash(readFileSync('.build/reference/ffmpeg'));
 expect(binarySha256).toBe(reference.artifacts.ffmpeg);expect(reference.commit).toBe(lock.commit);expect(fixture.upstreamCommit).toBe(lock.commit);
 expect(reference.flags).toEqual(readFileSync(lock.configureFile,'utf8').trim().split(/\s+/));
 // Historical ARM observations identify their own artifact; a Linux rebuild is a distinct oracle.
 expect(fixture.referenceBinarySha256).toMatch(/^[a-f0-9]{64}$/);expect([fixture.platform,fixture.arch]).toEqual(['Darwin','arm64']);
 let state=53;const input=Uint8Array.from({length:144},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state>>>24;});expect(hash(input)).toBe(fixture.input.sha256);
 for(const source of ['nv12','nv21']){const evidence=fixture.observations.find(item=>item.source===source&&item.options.length===0)!;expect(evidence.repeats).toBe(48);expect(Object.keys(evidence.outputHashes).length).toBeGreaterThan(1);expect(Object.values(evidence.outputHashes).reduce((a,b)=>a+b,0)).toBe(evidence.repeats);
  const control=fixture.observations.find(item=>item.source===source&&item.options.join(' ')==='-filter_threads 1')!;expect(control.repeats).toBe(12);expect(Object.keys(control.outputHashes)).toHaveLength(1);expect(Object.values(control.outputHashes).reduce((a,b)=>a+b,0)).toBe(control.repeats);
 }
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-inverse-instability-'));
 try{
  writeFileSync(join(root,'input.raw'),input);const observations:Record<string,Record<string,number>>={};
  for(const source of ['nv12','nv21']){const counts:Record<string,number>={};for(let repeat=0;repeat<8;repeat++){const output=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',source,'-video_size','16x6','-i',join(root,'input.raw'),'-pix_fmt','rgb24','-f','rawvideo','-']);expect(output.length).toBe(288);const digest=hash(output);counts[digest]=(counts[digest]??0)+1;}observations[source]=counts;}
  // Fresh observations are recorded without asserting a probabilistic race on every run.
  const sameReferenceBinary=binarySha256===fixture.referenceBinarySha256;
  console.info('Inverse default native output hashes: '+JSON.stringify({platform:reference.platform,arch:reference.arch,binarySha256,sameReferenceBinary,observations}));
  expect(hash(readFileSync('.build/reference/ffmpeg'))).toBe(binarySha256);
  mkdirSync('compat/reports',{recursive:true});writeFileSync('compat/reports/inverse-instability.json',JSON.stringify({fixture:'compat/behavior-specs/inverse-native-instability.json',fixtureSha256:hash(readFileSync('compat/behavior-specs/inverse-native-instability.json')),historicalReferenceBinarySha256:fixture.referenceBinarySha256,currentReference:reference,currentReferenceBinarySha256:binarySha256,sameReferenceBinary,observations},null,2)+'\n');
  let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('unexpected');},async openWrite(){opens++;throw new Error('unexpected');}},backend:createMediaBackend({pixelArithmetic:'aarch64'})});
  for(const source of ['nv12','nv21'])for(const destination of destinations)for(const [width,height]of [[16,6],[32,8]] as const){const result=await frontend.exec(['-f','rawvideo','-pix_fmt',source,'-s',`${width}x${height}`,'-i','/input.raw','-pix_fmt',destination,'-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(result.diagnostics[0]?.message).toContain('nondeterministic');}expect(opens).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
