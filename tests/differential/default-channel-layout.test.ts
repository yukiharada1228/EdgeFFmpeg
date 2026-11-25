import {it,expect} from 'vitest';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend} from '@edge-ffmpeg/avformat';import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';import {defaultLayoutCorpus} from '../helpers/default-channel-layout.js';
it('matches all 512 Native default-layout outputs for raw and WAV inputs with enabled and disabled guessing',async()=>{
 // Native rows recorded from this host's pinned reference: the darwin-arm64 corpus or compat/behavior-specs/default-channel-layout/<pin id>/.
 const corpus=defaultLayoutCorpus(),base=corpus.dir+'/',hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),manifest=corpus.manifest;for(const[name,digest]of Object.entries(manifest.sha256))expect(hash(await readFile(base+name))).toBe(digest);
 const provenance=corpus.record;for(const[name,digest]of Object.entries(provenance.sources))expect(hash(await readFile(name))).toBe(digest);expect(hash(await readFile('.build/reference/libavutil/libavutil.a'))).toBe(provenance.librarySha256);for(const name of ['ffmpeg','ffprobe'] as const)expect(hash(await readFile('.build/reference/'+name))).toBe(provenance.reference.artifacts[name]);
 const rows=JSON.parse(await readFile(base+'cases.json','utf8')) as {argv:string[];input:string;output:string;sha256:string;exitCode:number}[];expect(rows).toHaveLength(512);const root=await mkdtemp(join(tmpdir(),'default-layout-')),failures:unknown[]=[];
 try{for(const [index,row]of rows.entries()){try{await writeFile(join(root,'input'),Buffer.from(row.input,'base64'));const result=await new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),backend:createMediaBackend(),budget:{maxResidentBytes:1048576,maxBufferBytes:128,maxPendingPackets:4,maxCpuTimeMs:10000}}).exec(['-y',...row.argv]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);expect(result.diagnostics).toEqual([]);const bytes=await readFile(join(root,'output'));expect(hash(bytes)).toBe(row.sha256);expect(bytes).toEqual(Buffer.from(row.output,'base64'));}catch(error){failures.push({index,argv:row.argv,error:String(error)});}}
 await writeFile('.build/default-layout-result.json',JSON.stringify({cases:rows.length,matched:rows.length-failures.length,failures,fullConformance:false},null,2)+'\n');expect(failures).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('matches all 512 fixed Native default-layout outputs through independent Node launcher processes',async()=>{
 const {verifiedDefaultLayoutCases}=await import('../helpers/default-channel-layout.js'),{spawnSync}=await import('node:child_process'),rows=verifiedDefaultLayoutCases(),root=await mkdtemp(join(tmpdir(),'default-layout-cli-')),failures:unknown[]=[];
 try{for(const[index,row]of rows.entries()){try{
  await writeFile(join(root,'input'),Buffer.from(row.input,'base64'));
  const result=spawnSync(process.execPath,['tools/cli/run.mjs','--root',root,'--','-y',...row.argv],{encoding:'utf8',timeout:15000});expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(row.exitCode);
  const summary=JSON.parse(result.stdout);expect(summary.outputs).toEqual(['/output']);expect(summary.diagnostics).toEqual([]);const bytes=await readFile(join(root,'output'));expect(bytes).toEqual(Buffer.from(row.output,'base64'));
 }catch(error){failures.push({index,argv:row.argv,error:String(error)});}}
 await writeFile('.build/default-layout-cli-result.json',JSON.stringify({cases:rows.length,matched:rows.length-failures.length,failures,fullConformance:false},null,2)+'\n');expect(failures).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
