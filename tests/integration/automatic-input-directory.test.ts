import {it,expect} from 'vitest';import {FFmpeg} from '@edge-ffmpeg/core';
import {createTimedVideoBackend} from '@edge-ffmpeg/avformat';import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
it('keeps unselected directory failures out of automatic and explicit successful video execution across six schedulers',async()=>{
 verifyH264Reference();const root=await mkdtemp(join(tmpdir(),'automatic-directory-')),bytes=Buffer.from([1,2,3,4,5,6,7,8]);let count=0;
 try{for(const directory of [0,1])for(const xerror of [false,true])for(const mode of ['automatic','mapped-good','mapped-bad']){
  const folder=join(root,directory+'-'+xerror+'-'+mode);await mkdir(folder);const base=['-y',...(xerror?['-xerror']:[])];
  for(let i=0;i<2;i++){const path=join(folder,'input'+i);if(i===directory)await mkdir(path);else await writeFile(path,bytes);base.push('-f','rawvideo','-pixel_format','gray','-video_size','2x2','-framerate','25','-i','/input'+i);}
  if(mode!=='automatic')base.push('-map',String(mode==='mapped-good'?1-directory:directory)+':v');base.push('-c:v','rawvideo','-bitexact','-f','rawvideo','/out');
  const native=spawnSync('.build/reference/ffmpeg',['-v','error',...base.map(value=>/^\/input[01]$/.test(value)||value==='/out'?join(folder,value.slice(1)):value)],{input:'',encoding:'utf8',timeout:15000});expect(native.error).toBeUndefined();expect(native.signal).toBeNull();
  const nativeBytes=await readFile(join(folder,'out'));await rm(join(folder,'out'));
  for(const scheduler of ['pull','activation','read-frames','queued','scheduled','producer'] as const){
   const stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];
   const backend=createTimedVideoBackend({limits:{numericProfile:'darwin-arm64',maxEvents:128,scheduler},storage(){const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};}});
   const result=await new FFmpeg({filesystem:await createNodeFileSystem({root:folder,maxReadBytes:65536,maxWriteBytes:65536}),backend}).exec(base);count++;
   expect(result.exitCode,scheduler+'/'+directory+'/'+xerror+'/'+mode+'/'+JSON.stringify(result.diagnostics)).toBe(native.status);
   expect(stores.every(store=>store.closed===1&&store.values.size===0)).toBe(true);
   if(mode==='mapped-bad')expect(result.diagnostics).toEqual([{code:'input-read-error',message:'Is a directory'}]);else expect(result.diagnostics).toEqual([]);
   const actual=await readFile(join(folder,'out')).catch(()=>null);
   if(mode==='mapped-bad'&&xerror){expect(result.outputs).toEqual([]);expect(actual).toBeNull();}
   else{expect(result.outputs).toEqual(['/out']);expect(actual).toEqual(nativeBytes);await rm(join(folder,'out'));}
  }
 }expect(count).toBe(72);}finally{await rm(root,{recursive:true,force:true});}
},60000);
