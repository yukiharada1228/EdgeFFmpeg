// Probe-only timing instrument (linux-probe/* branches; never merged). Measures where one mp4-stream-id iteration spends
// its time on the runner: the native ffmpeg spawn, the Worker dispatch and the two ffprobe spawns.
import {it,expect} from 'vitest';import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Input{id:string;input:string;ids:number[]}
it('times one mp4-stream-id row phase by phase',async()=>{
 const inputs=JSON.parse(readFileSync('compat/behavior-specs/mp4-selection/id-inputs.json','utf8')) as Input[],row=inputs[0]!;
 const bundle=await build({entryPoints:['tests/workers/mp4-copy-cli-fixture.ts'],tsconfig:'tsconfig.json',bundle:true,metafile:true,write:false,platform:'browser',format:'esm'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));await mf.ready;const bucket=await mf.getR2Bucket('BUCKET');
 const directory=mkdtempSync(join(tmpdir(),'edge-timing-')),t={write:0,ffmpeg:0,dispatch:0,ffprobe:0,list:0},counts={iterations:0,probes:0},distinct=new Set<string>();
 const now=()=>performance.now();
 const sp=(n:number,cmd:string,args:string[])=>{const s=now();for(let i=0;i<n;i++)spawnSync(cmd,args,{encoding:'utf8'});return (now()-s)/n;};
 const before={trueMs:sp(30,'/bin/true',[]),ffprobeVersionMs:sp(30,'.build/reference/ffprobe',['-version']),rssMb:process.memoryUsage().rss/1048576};
 for(const id of row.ids)for(const value of [String(id|0),'0x'+id.toString(16),'0'+id.toString(8)])for(const selector of ['0:i:'+value,'0:#'+value,'0:a:i:'+value,'0:v:#'+value])for(const map of [['-map',selector],['-map',selector+'?'],['-map','0','-map','-'+selector]]){
  const options=[...map,'-c','copy'],source=join(directory,'in.mp4'),native=join(directory,'native.mp4'),actual=join(directory,'actual.mp4');let s=now();
  writeFileSync(source,Buffer.from(row.input,'base64'));t.write+=now()-s;s=now();
  const reference=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',source,...options,'-f','mp4',native],{encoding:'utf8',timeout:10000});t.ffmpeg+=now()-s;s=now();
  const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(Buffer.from(row.input,'base64')),options})});const result=await response.json() as {exitCode:number;data:string|null};t.dispatch+=now()-s;
  if(!reference.status){s=now();writeFileSync(actual,Buffer.from(result.data!,'base64'));for(const file of [actual,native]){distinct.add(createHash('sha256').update(readFileSync(file)).digest('hex'));spawnSync('.build/reference/ffprobe',['-v','error','-show_streams','-show_packets','-show_data','-of','json',file],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});counts.probes++;}t.ffprobe+=now()-s;}
  s=now();await bucket.list();t.list+=now()-s;counts.iterations++;
 }
 const after={trueMs:sp(30,'/bin/true',[]),rssMb:process.memoryUsage().rss/1048576};
 const report={host:{cpus:(await import('node:os')).cpus()[0]?.model,arch:process.arch,node:process.version},before,after,totalsMs:Object.fromEntries(Object.entries(t).map(([k,v])=>[k,Math.round(v)])),counts,distinctProbedOutputs:distinct.size};
 console.log('[timing] '+JSON.stringify(report));mkdirSync('.build/linux-probe',{recursive:true});writeFileSync('.build/linux-probe/mp4-iteration-timing.json',JSON.stringify(report,null,2));
 await mf.dispose();rmSync(directory,{recursive:true,force:true});expect(counts.iterations).toBe(108);
},600000);
