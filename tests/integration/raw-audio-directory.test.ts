import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createWavBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
it('matches Native raw audio and video directory statuses while retaining atomic output effects as a known difference',async()=>{
 const profiles=JSON.parse(await readFile('compat/behavior-specs/output-open/profiles.json','utf8')).slice(0,8) as {id:string;inputOptions:string[];outputOptions:string[]}[];
 const metadata=JSON.parse(await readFile('.build/reference/build-metadata.json','utf8'));
 expect(createHash('sha256').update(await readFile('.build/reference/ffmpeg')).digest('hex')).toBe(metadata.artifacts.ffmpeg);
 const root=await mkdtemp(join(tmpdir(),'raw-directory-')),sentinel=Buffer.from('prior output');let count=0,knownEffects=0;
 try{
  for(const profile of profiles)for(const xerror of [false,true])for(const existing of [false,true])for(const flags of [[],['-n'],['-y'],['-y','-n'],['-n','-y']]){
   const folder=join(root,String(count++));await mkdir(join(folder,'input'),{recursive:true});
   if(existing){await writeFile(join(folder,'native'),sentinel);await writeFile(join(folder,'actual'),sentinel);}
   const args=[...(xerror?['-xerror']:[]),...flags,...profile.inputOptions,'-i','/input','-fflags','+bitexact',...profile.outputOptions,'/actual'];
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input'?join(folder,'input'):value==='/actual'?join(folder,'native'):value)],{input:'',encoding:'utf8',timeout:15000});
   expect(native.error).toBeUndefined();expect(native.signal).toBeNull();
   const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:4096,maxWriteBytes:4096}),backend:createWavBackend()}).exec(args);
   expect(result.exitCode,profile.id+'/'+xerror+'/'+existing+'/'+flags).toBe(native.status);
   const conflict=flags.includes('-y')&&flags.includes('-n'),refused=existing&&!flags.includes('-y');
   if(conflict||refused){
    expect(result.outputs).toEqual([]);if(existing)expect(await readFile(join(folder,'actual'))).toEqual(sentinel);
    else await expect(access(join(folder,'actual'))).rejects.toThrow();
   }else if(xerror){
    expect(result.diagnostics.at(-1)?.code).toBe('input-read-error');expect(result.outputs).toEqual([]);
    if(existing)expect(await readFile(join(folder,'actual'))).toEqual(sentinel);else await expect(access(join(folder,'actual'))).rejects.toThrow();
    await access(join(folder,'native'));knownEffects++;
   }else{
    expect(result.outputs).toEqual(['/actual']);expect(result.diagnostics).toEqual([{code:'input-read-error',message:'Is a directory'}]);
    expect(await readFile(join(folder,'actual'))).toEqual(await readFile(join(folder,'native')));
   }
  }
  expect(count).toBe(160);expect(knownEffects).toBe(32);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
it('reports initial raw read failure even when zero frames duration or seek schedules no packets',async()=>{
 const profiles=JSON.parse(await readFile('compat/behavior-specs/output-open/profiles.json','utf8')).slice(0,8) as {id:string;inputOptions:string[];outputOptions:string[]}[];
 const root=await mkdtemp(join(tmpdir(),'raw-directory-termination-'));let count=0;
 try{
  for(const profile of profiles)for(const errorFlags of [[],['-xerror'],['-noxerror'],['-xerror','-noxerror'],['-noxerror','-xerror']])for(const mode of ['normal','zero-frames','zero-duration','input-seek','output-seek']){
   const xerror=errorFlags.at(-1)==='-xerror';
   const folder=join(root,String(count++));await mkdir(join(folder,'input'),{recursive:true});
   const before=mode==='input-seek'?['-ss','0.001']:[];
   const after=mode==='zero-frames'?[profile.id.includes('video')?'-frames:v':'-frames:a','0']:mode==='zero-duration'?['-t','0']:mode==='output-seek'?['-ss','0.001']:[];
   const args=['-y',...errorFlags,...profile.inputOptions,...before,'-i','/input','-fflags','+bitexact',...profile.outputOptions,...after,'/actual'];
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input'?join(folder,'input'):value==='/actual'?join(folder,'native'):value)],{input:'',encoding:'utf8',timeout:15000});
   expect(native.error).toBeUndefined();expect(native.signal).toBeNull();
   const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:4096,maxWriteBytes:4096}),backend:createWavBackend()}).exec(args);
   expect(result.exitCode,profile.id+'/'+xerror+'/'+mode).toBe(native.status);
   expect(result.exitCode).toBe(xerror?235:0);
   expect(result.diagnostics).toEqual([{code:'input-read-error',message:'Is a directory'}]);
   if(xerror){expect(result.outputs).toEqual([]);await expect(access(join(folder,'actual'))).rejects.toThrow();}
   else{expect(result.outputs).toEqual(['/actual']);expect(await readFile(join(folder,'actual'))).toEqual(await readFile(join(folder,'native')));}
  }
  expect(count).toBe(200);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
