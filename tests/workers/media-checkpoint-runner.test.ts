import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {pinnedReference} from '../helpers/reference-identity.js';
type Run={outcome:string;units:number;commitRetries:number;status:MediaCheckpointStatus|null;finalized:{bytes:string;revisions:number;outputChunks:number;existing?:true}|null;conflict:string|null;stages:number;error?:string};
it('automatically resumes an R2-backed audio FIFO across killed runtimes, a lost commit reply and a crash after commit, then publishes Native-identical bytes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-media-checkpoint-runner-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const bundle=await build({entryPoints:[root+'/media-checkpoint-runner-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'media-checkpoint-runner-test',modules:[{type:'ESModule',path:root+'/media-checkpoint-runner-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{CHECKPOINTS:{className:'MediaCheckpointCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 // 23 stereo samples (not a multiple of the 5-sample unit or 3-sample frame), including int16 extremes.
 const samples=23,input=Buffer.alloc(samples*4);for(let i=0;i<samples;i++){input.writeInt16LE(i===3?32767:i===4?-32768:((i*7919)%65536)-32768,i*4);input.writeInt16LE(i===5?-32768:((i*104729+17)%65536)-32768,i*4+2);}
 const fingerprint=createHash('sha256').update(input).digest('hex'),inputPath=join(directory,'input.raw');writeFileSync(inputPath,input);
 const restart=async()=>{await mf.dispose();mf=start();await mf.ready;return mf.getR2Bucket('MEDIA_BUCKET');};
 try{
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');const etag=(await bucket.put('inputs/runner.s16le',input,{customMetadata:{edgeInputSha256:fingerprint}}))!.etag;
  for(const pad of [0,1]){
   const query=(extra:string)=>'?pad='+pad+'&etag='+encodeURIComponent(etag)+'&fingerprint='+fingerprint+extra;
   const run=async(extra='',status=200)=>{const response=await mf.dispatchFetch('https://runner.test/run'+query(extra)),value=await response.json() as Run;expect(response.status,JSON.stringify(value)).toBe(status);return value;};
   const journal=async()=>(await(await mf.dispatchFetch('https://runner.test/status'+query(''))).json()) as MediaCheckpointStatus;
   const expire=async()=>{const lease=(await journal()).lease;if(lease)while(Date.now()<=lease.expiresAt+5)await new Promise(resolve=>setTimeout(resolve,10));};
   // Invocation 1 stops at its unit budget; the runtime is then destroyed.
   const first=await run('&maxUnits=2&leaseMs=3000');expect(first).toMatchObject({outcome:'yielded',units:2,commitRetries:0,finalized:null});expect(first.status).toMatchObject({phase:'running',revision:2,inputPosition:'10',outputPosition:'36'});
   bucket=await restart();expect(await run('&maxUnits=2')).toMatchObject({outcome:'busy',units:0});await expire();
   // Invocation 2 restores revision 2 in a fresh runtime and loses one commit reply.
   const second=await run('&maxUnits=1&mode=lostAck');expect(second).toMatchObject({outcome:'yielded',units:1,commitRetries:1});expect(second.status).toMatchObject({revision:3,inputPosition:'15',outputPosition:'60'});expect((await journal()).commits).toHaveLength(3);
   bucket=await restart();await expire();
   // Invocation 3 commits revision 4, then its runtime dies before the reply arrives.
   const crashed=await run('&maxUnits=2&mode=crash&leaseMs=3000',500);expect(crashed.error).toMatch(/Injected runtime loss/);bucket=await restart();
   const afterCrash=await journal();expect(afterCrash).toMatchObject({phase:'running',revision:4,inputPosition:'20',outputPosition:'72'});expect(await run('&maxUnits=8')).toMatchObject({outcome:'busy'});await expire();
   const finished=await run('&maxUnits=8');expect(finished).toMatchObject({outcome:'finished',units:1,commitRetries:0,stages:0});expect(finished.finalized).toEqual({bytes:String(pad?96:92),revisions:5,outputChunks:5});
   const status=finished.status!;expect(status).toMatchObject({phase:'finished',lease:null,revision:5,inputPosition:'23',outputPosition:String(pad?96:92)});expect(status.commits.map(commit=>commit.revision)).toEqual([1,2,3,4,5]);expect(new Set(status.commits.map(commit=>commit.state.key.split('/').slice(2,4).join('/'))).size).toBe(4);
   // Replay neither claims nor republishes; it verifies the published bytes against the journal.
   const published=(await bucket.head('final/runner-'+pad+'.raw'))!;const replay=await run('&maxUnits=8');expect(replay).toMatchObject({outcome:'finished',units:0,conflict:null,stages:0});expect(replay.finalized).toEqual({bytes:String(pad?96:92),revisions:5,outputChunks:5,existing:true});expect((await bucket.head('final/runner-'+pad+'.raw'))!.version).toBe(published.version);
   const output=join(directory,'native-'+pad+'.raw'),crc=join(directory,'native-'+pad+'.crc');
   execFileSync(binary,['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i',inputPath,'-filter_complex',`[0:a]aformat=sample_fmts=s16p,asetnsamples=n=3:p=${pad},asetpts=PTS+123,asplit=2[a][b]`,'-map','[a]','-c:a','pcm_s16le','-f','s16le',output,'-map','[b]','-c:a','pcm_s16le','-f','framecrc',crc],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
   const actual=Buffer.from(await(await bucket.get('final/runner-'+pad+'.raw'))!.arrayBuffer());expect(actual.length).toBe(pad?96:92);expect(actual).toEqual(readFileSync(output));
   const frames=readFileSync(crc,'utf8').split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const fields=line.split(',').map(value=>value.trim());return {samples:Number(fields[3]),pts:fields[2]!};});expect(frames).toHaveLength(8);
   const committed=await(await mf.dispatchFetch('https://runner.test/frames'+query(''))).json();expect(committed).toEqual(frames);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
