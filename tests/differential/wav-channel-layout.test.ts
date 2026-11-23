import {it,expect} from 'vitest';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openWav} from '@edge-ffmpeg/containers';
import {memoryInput} from '../helpers/wav.js';
it('matches Native WAV contradictory-mask fallback with default and disabled layout guessing',async()=>{
 const base='compat/behavior-specs/wav-channel-layout/',hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
 const manifest=JSON.parse(await readFile(base+'manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const [name,digest] of Object.entries(manifest.sha256))expect(hash(await readFile(base+name))).toBe(digest);
 const provenance=JSON.parse(await readFile(base+'provenance.json','utf8')) as {sources:Record<string,string>;reference:{artifacts:Record<string,string>}};
 for(const [name,digest] of Object.entries(provenance.sources))expect(hash(await readFile(name))).toBe(digest);
 for(const name of ['ffmpeg','ffprobe'])expect(hash(await readFile('.build/reference/'+name))).toBe(provenance.reference.artifacts[name]);
 const fixture=JSON.parse(await readFile(base+'cases.json','utf8')) as {rows:{channels:number;mask:number;samples:number;guess:boolean;input:string;output:string;sha256:string;exitCode:number}[]};
 expect(fixture.rows).toHaveLength(72);const root=await mkdtemp(join(tmpdir(),'wav-layout-'));
 try {for(const row of fixture.rows){
  const input=Buffer.from(row.input,'base64');await writeFile(join(root,'input.wav'),input);
  const source=await openWav(memoryInput(input),{maxReadBytes:8});
  expect(source.info.channelMask).toBe(row.mask.toString(2).replaceAll('0','').length===row.channels?row.mask:null);
  const result=await new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),backend:createMediaBackend(),budget:{maxResidentBytes:1048576,maxBufferBytes:64,maxPendingPackets:4,maxCpuTimeMs:10000}}).exec(['-y',...(row.guess?[]:['-guess_layout_max','0']),'-i','/input.wav','-c:a','copy','-bitexact','/output.wav']);
  expect(result.exitCode,JSON.stringify(row)).toBe(row.exitCode);expect(result.diagnostics).toEqual([]);
  const output=await readFile(join(root,'output.wav'));expect(hash(output)).toBe(row.sha256);expect(output).toEqual(Buffer.from(row.output,'base64'));
 }}finally{await rm(root,{recursive:true,force:true});}
});
it('matches all 72 Native WAV layout fallback cases through independent Node launcher processes',async()=>{
 const {spawnSync}=await import('node:child_process');
 const fixture=JSON.parse(await readFile('compat/behavior-specs/wav-channel-layout/cases.json','utf8')) as {rows:{input:string;output:string;guess:boolean;exitCode:number}[]};
 expect(fixture.rows).toHaveLength(72);const root=await mkdtemp(join(tmpdir(),'wav-layout-cli-'));
 try{for(const row of fixture.rows){
  await writeFile(join(root,'input.wav'),Buffer.from(row.input,'base64'));
  const result=spawnSync(process.execPath,['tools/cli/run.mjs','--root',root,'--','-y',...(row.guess?[]:['-guess_layout_max','0']),'-i','/input.wav','-c:a','copy','-bitexact','/output.wav'],{encoding:'utf8',timeout:15000});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(row.exitCode);
  const summary=JSON.parse(result.stdout);expect(summary.diagnostics).toEqual([]);expect(summary.outputs).toEqual(['/output.wav']);
  expect(await readFile(join(root,'output.wav'))).toEqual(Buffer.from(row.output,'base64'));
 }}finally{await rm(root,{recursive:true,force:true});}
},30000);
