import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
it('matches Native graph directory-read statuses across 2520 backend executions with explicit atomic output differences',async()=>{
 verifyH264Reference();
 const source='compat/behavior-specs/multi-output-policy/',profiles=JSON.parse(await readFile(source+'profiles.json','utf8')) as {id:string;argv:string[]}[],inputs=JSON.parse(await readFile(source+'inputs.json','utf8')) as {path:string;input:string}[];
 const backends=['media','pull','activation','read-frames','queued','scheduled','producer'] as const;
 const root=await mkdtemp(join(tmpdir(),'graph-directory-')),sentinel=Buffer.from([17,31,43]);let count=0,executions=0,knownFailureEffects=0,knownRefusalEffects=0;
 try{for(const profile of profiles){const paths=profile.argv.filter((_,i)=>profile.argv[i-1]==='-i');for(const directory of paths)for(const flags of [[],['-n'],['-y'],['-y','-n'],['-n','-y']])for(const xerror of [false,true])for(let mask=0;mask<4;mask++){
  const folder=join(root,String(count++));for(const who of ['native',...backends]){const dir=join(folder,who);await mkdir(dir,{recursive:true});for(const input of inputs){const path=join(dir,input.path.slice(1));if(input.path===directory)await mkdir(path);else await writeFile(path,Buffer.from(input.input,'base64'));}for(let i=0;i<2;i++)if(mask&(1<<i))await writeFile(join(dir,'output-'+i+'.bin'),sentinel);}
  const args=[...(xerror?['-xerror']:[]),...flags,...profile.argv],native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(a=>/^\/(input|output)-\d\.(raw|bin)$/.test(a)?join(folder,'native',a.slice(1)):a)],{input:'',encoding:'utf8',timeout:15000});
  expect(native.error).toBeUndefined();expect(native.signal).toBeNull();
  for(const backendId of backends){
  const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];
  const backend=backendId==='media'?createMediaBackend():createTimedVideoBackend({limits:{numericProfile:'darwin-arm64',maxEvents:128,scheduler:backendId},storage(){const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};}});
  const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:join(folder,backendId),maxReadBytes:65536,maxWriteBytes:65536}),backend}).exec(args);executions++;
  expect(stores.every(store=>store.closed===1&&store.values.size===0),backendId+' store cleanup').toBe(true);
  expect(result.exitCode,backendId+'/'+profile.id+'/'+directory+'/'+flags+'/'+xerror+'/'+mask+'/'+JSON.stringify(result.diagnostics)).toBe(native.status);
  const conflict=flags.includes('-y')&&flags.includes('-n'),refused=!conflict&&!flags.includes('-y')&&mask!==0,failed=xerror&&!conflict&&!refused;
  for(let i=0;i<2;i++){
   const nativeBytes=await readFile(join(folder,'native','output-'+i+'.bin')).catch(()=>null),edgeBytes=await readFile(join(folder,backendId,'output-'+i+'.bin')).catch(()=>null);
   if(conflict||refused||failed)expect(edgeBytes).toEqual(mask&(1<<i)?sentinel:null);else expect(edgeBytes).toEqual(nativeBytes);
   const same=nativeBytes===null?edgeBytes===null:edgeBytes!==null&&nativeBytes.equals(edgeBytes);
   if(failed&&!same)knownFailureEffects++;
   if(refused&&!same)knownRefusalEffects++;
  }
  if(conflict||refused||failed)expect(result.outputs).toEqual([]);else{expect(result.outputs).toEqual(['/output-0.bin','/output-1.bin']);expect(result.diagnostics).toEqual([{code:'input-read-error',message:'Is a directory'}]);}
 }}}expect(count).toBe(360);expect(executions).toBe(2520);expect(knownFailureEffects).toBe(756);expect(knownRefusalEffects).toBe(252);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
