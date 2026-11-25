import {it,expect} from 'vitest';import {createHash} from 'node:crypto';import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';import {loadH264Module} from '../helpers/h264-corpus.js';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {selectNativeCorpus} from '../helpers/native-corpus.js';
// Native rows recorded from this host's pinned reference: the darwin-arm64 corpus or compat/behavior-specs/reference-metadata/<pin id>/.
const metadataCorpus=()=>selectNativeCorpus('compat/behavior-specs/reference-metadata','tools/differential-runner/reference-metadata/generate.mjs');
it('matches fixed Native default and bitexact metadata bytes across 336 cases and all timed graph schedulers',async()=>{
 const corpus=metadataCorpus(),source=corpus.dir+'/',hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),manifest=corpus.manifest;
 for(const[n,digest]of Object.entries(manifest.sha256))expect(hash(await readFile(source+n))).toBe(digest);
 const provenance=corpus.record;for(const[p,digest]of Object.entries(provenance.sources))expect(hash(await readFile(p))).toBe(digest);
 for(const n of ['ffmpeg','ffprobe'] as const)expect(hash(await readFile('.build/reference/'+n))).toBe(provenance.reference.artifacts[n]);
 const rows=JSON.parse(await readFile(source+'cases.json','utf8')) as {id:string;group:string;inputs:{path:string;base64:string}[];argv:string[];outputs:{path:string;bytes:number;sha256:string;base64:string}[]}[];
 expect(rows).toHaveLength(336);const root=await mkdtemp(join(tmpdir(),'reference-metadata-')),module=new WebAssembly.Module(loadH264Module()),media=createMediaBackend({h264:{module,maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384}}),failures:unknown[]=[];let executions=0,matched=0;
 try{for(const row of rows)for(const scheduler of row.group==='graph'?['media','pull','activation','read-frames','queued','scheduled','producer'] as const:['media'] as const){
  const folder=join(root,row.id+'-'+scheduler);try{
   await mkdir(folder);for(const input of row.inputs)await writeFile(join(folder,input.path.slice(1)),Buffer.from(input.base64,'base64'));
   const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];
   const backend=scheduler==='media'?media:createTimedVideoBackend({limits:{numericProfile:'darwin-arm64',maxEvents:128,scheduler},storage(){const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};}});
   executions++;const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:1048576,maxWriteBytes:1048576}),backend,budget:{maxResidentBytes:134217728,maxBufferBytes:1048576,maxPendingPackets:32,maxCpuTimeMs:60000}}).exec(['-y',...row.argv]);
   expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(stores.every(s=>s.closed===1&&s.values.size===0)).toBe(true);
   for(const output of row.outputs){const actual=await readFile(join(folder,output.path.slice(1))),expected=Buffer.from(output.base64,'base64');expect(expected.length).toBe(output.bytes);expect(hash(expected)).toBe(output.sha256);expect(actual).toEqual(expected);}matched++;
  }catch(error){failures.push({id:row.id,scheduler,argv:row.argv,error:String(error)});}finally{await rm(folder,{recursive:true,force:true});}
 }
 await writeFile('.build/reference-metadata-result.json',JSON.stringify({nativeCases:336,executions,matched,failures,fullConformance:false},null,2)+'\n');expect(failures).toEqual([]);expect(executions).toBe(462);expect(matched).toBe(462);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
it('matches all 336 fixed Native metadata outputs through independent cached Node launcher processes',async()=>{
 const corpus=metadataCorpus(),source=corpus.dir+'/',hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),manifest=corpus.manifest;
 for(const[n,digest]of Object.entries(manifest.sha256))expect(hash(await readFile(source+n))).toBe(digest);
 const provenance=corpus.record;for(const[p,digest]of Object.entries(provenance.sources))expect(hash(await readFile(p))).toBe(digest);
 for(const n of ['ffmpeg','ffprobe'] as const)expect(hash(await readFile('.build/reference/'+n))).toBe(provenance.reference.artifacts[n]);
 const rows=JSON.parse(await readFile(source+'cases.json','utf8')) as {id:string;group:string;inputs:{path:string;base64:string}[];argv:string[];outputs:{path:string;sha256:string;base64:string}[]}[];
 expect(rows).toHaveLength(336);const root=await mkdtemp(join(tmpdir(),'metadata-cached-cli-')),failures:unknown[]=[];let matched=0;
 try{for(const row of rows){const folder=join(root,row.id);try{
  await mkdir(folder);for(const input of row.inputs)await writeFile(join(folder,input.path.slice(1)),Buffer.from(input.base64,'base64'));
  const result=spawnSync(process.execPath,['tools/cli/run.mjs','--root',folder,...(row.group==='h264'?['--h264-wasm',resolve('.build/codecs/openh264/openh264.wasm')]:[]),'--','-y',...row.argv],{encoding:'utf8',timeout:15000});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  const summary=JSON.parse(result.stdout);expect(summary.diagnostics).toEqual([]);expect(summary.outputs).toEqual(row.outputs.map(output=>output.path));
  for(const output of row.outputs){const actual=await readFile(join(folder,output.path.slice(1)));expect(hash(actual)).toBe(output.sha256);expect(actual).toEqual(Buffer.from(output.base64,'base64'));}matched++;
 }catch(error){failures.push({id:row.id,error:String(error)});}finally{await rm(folder,{recursive:true,force:true});}}
 await writeFile('.build/metadata-launcher-cli-test-result.json',JSON.stringify({cases:336,matched,failures,fullConformance:false},null,2)+'\n');expect(failures).toEqual([]);expect(matched).toBe(336);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
