import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {loadH264Module} from '../helpers/h264-corpus.js';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
it('matches Native BMP no-stream and MP4 discovery failures before output policy across 720 cases',async()=>{
 verifyH264Reference();
 const profiles=JSON.parse(await readFile('compat/behavior-specs/output-open/profiles.json','utf8')).slice(8) as {id:string;inputOptions:string[];outputOptions:string[]}[];
 const module=new WebAssembly.Module(loadH264Module()),backend=createMediaBackend({h264:{module,maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384}});
 const root=await mkdtemp(join(tmpdir(),'headered-directory-')),sentinel=Buffer.from('prior output');let count=0;
 try{
  for(const p of profiles)for(const existing of [false,true])for(const errorFlags of [[],['-xerror']])for(const flags of [[],['-n'],['-y'],['-y','-n'],['-n','-y']])for(const populated of [false,true]){
   const folder=join(root,String(count++));await mkdir(join(folder,'input'),{recursive:true});if(populated)await writeFile(join(folder,'input/member'),sentinel);
   if(existing)await writeFile(join(folder,'result'),sentinel);
   const args=[...errorFlags,...flags,...p.inputOptions,'-i','/input',...p.outputOptions,'/result'];
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input'?join(folder,'input'):value==='/result'?join(folder,'result'):value)],{input:'',encoding:'utf8',timeout:15000});
   expect(native.error).toBeUndefined();expect(native.signal).toBeNull();
   const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:1048576,maxWriteBytes:1048576}),backend,budget:{maxResidentBytes:134217728,maxBufferBytes:1048576,maxPendingPackets:32,maxCpuTimeMs:60000}}).exec(args);
   const bmp=p.id.startsWith('bmp');expect(native.status,p.id).toBe(bmp?234:183);expect(result.exitCode,p.id+'/'+args+'/'+JSON.stringify(result.diagnostics)).toBe(native.status);
   expect(result.outputs).toEqual([]);expect(result.diagnostics).toEqual([bmp?{code:'invalid-arguments',message:'Output file does not contain any stream'}:{code:'invalid-data',message:'moov atom not found'}]);
   if(existing)expect(await readFile(join(folder,'result'))).toEqual(sentinel);
   expect((await readdir(folder)).sort()).toEqual(existing?['input','result']:['input']);
   expect(await readdir(join(folder,'input'))).toEqual(populated?['member']:[]);
  }
  expect(count).toBe(720);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
