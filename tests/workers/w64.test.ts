import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const native=resolve('.build/reference/ffmpeg'),codecs=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_alaw','pcm_mulaw'];
it('matches Native W64 mux, auto-detected demux and W64-to-WAV bytes inside workerd with bounded I/O',async()=>{
 const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-w64-workerd-')),nativeFile=(args:readonly string[],name:string)=>{execFileSync(native,['-v','error','-y',...args,join(root,name)],{timeout:30000});return readFileSync(join(root,name));};
 const bundle=await build({entryPoints:['tests/workers/w64-fixture.ts'],bundle:true,platform:'browser',format:'esm',write:false}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19'}));
 try{
  await mf.ready;// 304 stereo frames pad to whole frames for every codec (s24: 1824 bytes).
  const raw=new Uint8Array(304*2*2),view=new DataView(raw.buffer);for(let i=0;i<608;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),raw);let cases=0;
  for(const codec of codecs)for(const rate of [8000,96000]){
   const w64=nativeFile(['-f','s16le','-ar',String(rate),'-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact','-f','w64'],`${codec}-${rate}.w64`);
   for(const [input,args,expected] of [
    [raw,['-f','s16le','-ar',String(rate),'-ac','2','-i','/input.raw','-c:a',codec,'-bitexact','-f','w64','/output.w64'],w64],
    [w64,['-i','/input.w64','-c:a','copy','-bitexact','-f','framecrc','/output.crc'],nativeFile(['-i',join(root,`${codec}-${rate}.w64`),'-c:a','copy','-bitexact','-f','framecrc'],`${codec}-${rate}.crc`)],
    [w64,['-cpuflags','0','-i','/input.w64','-c:a','pcm_s16le','-bitexact','/output.wav'],nativeFile(['-cpuflags','0','-i',join(root,`${codec}-${rate}.w64`),'-c:a','pcm_s16le','-bitexact'],`${codec}-${rate}.wav`)]
   ] as const){
    const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input:Array.from(input),args})});expect(response.status).toBe(200);
    const actual=await response.json() as {exitCode:number;outputs:string[];diagnostics:unknown[];data:number[];committed:boolean;aborted:boolean;maximumRead:number;maximumWrite:number};
    expect(actual.exitCode,JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.outputs).toEqual([args.at(-1)]);expect(actual.diagnostics).toEqual([]);
    expect(Buffer.from(actual.data).equals(expected),`${codec}/${rate}/${args.at(-1)}`).toBe(true);expect(actual.committed).toBe(true);expect(actual.aborted).toBe(false);expect(actual.maximumRead).toBeLessThanOrEqual(64);expect(actual.maximumWrite).toBeLessThanOrEqual(64);cases++;
   }
  }
  const refused=await (await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input:Array.from(raw),args:['-f','s16le','-i','/input.raw','-c:a','pcm_s16be','-f','w64','/output.w64']})})).json() as {exitCode:number;committed:boolean;data:number[]};
  expect(refused.exitCode).not.toBe(0);expect(refused.committed).toBe(false);expect(refused.data).toEqual([]);expect(cases).toBe(48);
 }finally{await mf.dispose();rmSync(root,{recursive:true,force:true});}
},120000);
