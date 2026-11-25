// Probe-only timing instrument (linux-probe/* branches; never merged). Compares the Worker dispatch time of one
// mp4-stream-id row with Miniflare's local R2 storage under the default temporary directory and under tmpfs /dev/shm.
import {it,expect} from 'vitest';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {cpus,tmpdir} from 'node:os';
interface Input{id:string;input:string;ids:number[]}
it('times Worker dispatches per Miniflare storage location',async()=>{
 const row=(JSON.parse(readFileSync('compat/behavior-specs/mp4-selection/id-inputs.json','utf8')) as Input[])[0]!;
 const bundle=await build({entryPoints:['tests/workers/mp4-copy-cli-fixture.ts'],tsconfig:'tsconfig.json',bundle:true,metafile:true,write:false,platform:'browser',format:'esm'});
 const mounts=readFileSync('/proc/mounts','utf8').split('\n').filter(line=>/ (\/tmp|\/dev\/shm|\/) /.test(line));
 const variants:Record<string,unknown>={};const original=process.env.TMPDIR;
 for(const [label,dir] of [['default',undefined],['dev-shm','/dev/shm'],['default-again',undefined]] as const){
  if(dir)process.env.TMPDIR=dir;else if(original===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=original;
  const where=tmpdir(),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));await mf.ready;
  let n=0,reads=0,writes=0;const start=performance.now();
  for(const id of row.ids)for(const value of [String(id|0),'0x'+id.toString(16),'0'+id.toString(8)])for(const selector of ['0:i:'+value,'0:#'+value,'0:a:i:'+value,'0:v:#'+value])for(const map of [['-map',selector],['-map',selector+'?'],['-map','0','-map','-'+selector]]){
   const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(Buffer.from(row.input,'base64')),options:[...map,'-c','copy']})});const result=await response.json() as {reads?:number;writes?:number};reads+=result.reads??0;writes+=result.writes??0;n++;
  }
  variants[label]={tmpdir:where,dispatches:n,totalMs:Math.round(performance.now()-start),reads,writes};await mf.dispose();
 }
 const report={cpu:cpus()[0]?.model,cpus:cpus().length,mounts,variants};
 console.log('[storage-timing] '+JSON.stringify(report));mkdirSync('.build/linux-probe',{recursive:true});writeFileSync('.build/linux-probe/mp4-dispatch-storage.json',JSON.stringify(report,null,2));
 expect(Object.keys(variants)).toHaveLength(3);
},900000);
