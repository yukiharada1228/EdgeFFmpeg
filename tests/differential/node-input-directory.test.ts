import {it,expect} from 'vitest';import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend} from '@edge-ffmpeg/avformat';import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {nodeInputDirectoryCases} from '../helpers/node-input-directory.js';import {loadH264Module} from '../helpers/h264-corpus.js';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
async function optionalRead(path:string){try{return await readFile(path);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return null;throw error;}}
it('matches 1932 fixed Native directory statuses while retaining 300 cases with known output differences',async()=>{
 const rows=nodeInputDirectoryCases(),root=await mkdtemp(join(tmpdir(),'fixed-input-directory-')),sentinel=Buffer.from([17,31,43]);
 const module=new WebAssembly.Module(loadH264Module()),backend=createMediaBackend({h264:{module,maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384}});
 const failures:unknown[]=[],known:{id:string;kind:string;outputs:number}[]=[];let matched=0,exactOutputCases=0;
 try{for(const row of rows){const folder=join(root,row.id);try{
  await mkdir(folder);for(const path of row.directoryPaths){await mkdir(join(folder,path.slice(1)));if(row.populated)await writeFile(join(folder,path.slice(1),'member'),sentinel);}
  for(const input of row.regularInputs)if(!row.directoryPaths.includes(input.path))await writeFile(join(folder,input.path.slice(1)),Buffer.from(input.input,'base64'));
  for(const[index,path]of row.outputPaths.entries())if(row.mask&(1<<index))await writeFile(join(folder,path.slice(1)),sentinel);
  const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:1048576,maxWriteBytes:1048576}),backend,budget:{maxResidentBytes:134217728,maxBufferBytes:1048576,maxPendingPackets:32,maxCpuTimeMs:60000}}).exec(row.argv);
  expect(result.exitCode,row.id+'/'+JSON.stringify(result.diagnostics)).toBe(row.exitCode);matched++;
  let different=0,kind='';for(const[index,path]of row.outputPaths.entries()){
   const actual=await optionalRead(join(folder,path.slice(1))),expected=row.outputs[index]?Buffer.from(row.outputs[index]!.base64,'base64'):null;
   if(actual===null?expected===null:expected!==null&&actual.equals(expected))continue;
   different++;
   if(row.exitCode===235){kind='atomic-error-publication';expect(actual).toEqual(row.mask&(1<<index)?sentinel:null);}
   else if(result.diagnostics.some(d=>d.code==='output-exists')){kind='atomic-late-refusal';expect(actual).toEqual(row.mask&(1<<index)?sentinel:null);}
   else expect(actual).toEqual(expected);
  }
  if(different)known.push({id:row.id,kind,outputs:different});else exactOutputCases++;
 }catch(error){failures.push({id:row.id,error:String(error)});}finally{await rm(folder,{recursive:true,force:true});}}
 await writeFile('.build/input-directory-result.json',JSON.stringify({cases:rows.length,matched,exactOutputCases,knownOutputDifferenceCases:known.length,knownOutputDifferences:known.reduce((n,r)=>n+r.outputs,0),known,failures,fullConformance:false},null,2)+'\n');
 expect(known).toEqual(JSON.parse(await readFile('compat/known-differences/node-input-directory.json','utf8')).knownCases);
 expect(failures).toEqual([]);expect(matched).toBe(1932);expect(exactOutputCases).toBe(1632);expect(known).toHaveLength(300);
 expect(known.filter(r=>r.kind==='atomic-error-publication')).toHaveLength(264);expect(known.filter(r=>r.kind==='atomic-late-refusal')).toHaveLength(36);expect(known.filter(r=>r.kind==='default-encoder-metadata')).toHaveLength(0);expect(known.reduce((n,r)=>n+r.outputs,0)).toBe(354);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
