import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {lowerComplexVideoCommand,planIndependentGraph} from '@edge-ffmpeg/core';
import type {MediaWorkflowResult,MediaWorkflowManifest,MediaWorkflowSpec} from '@edge-ffmpeg/runtime-cloudflare/jobs';
import {complexCommandGraph,complexCommandBudget,complexCommandInput} from '../helpers/complex-command-graph.js';
it('runs automatically lowered split/join and multi-output video graphs through actual Workflows and R2',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-complex-graph-workflow-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const bundle=await build({entryPoints:[root+'/media-workflow-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const mf=new Miniflare(convertV4MiniflareOptions({name:'complex-graph-workflow-test',modules:[{type:'ESModule',path:root+'/complex-command-graph-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{JOBS:{className:'MediaJobCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET'],queueProducers:{MEDIA_JOB_QUEUE:'complex-graph-jobs'},queueConsumers:{'complex-graph-jobs':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:1,retryDelay:0}},workflows:{MEDIA_WORKFLOW:{name:'complex-graph-workflow-local',className:'MediaWorkflow'}}}));
 try{
  await mf.ready;const bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/video.raw',complexCommandInput);
  for(const mode of ['join','outputs'] as const){
   const id='complex-'+mode,response=await mf.dispatchFetch('https://workflow.test/create-complex?id='+id,{method:'POST',body:JSON.stringify({mode})}),created=await response.json() as {spec:MediaWorkflowSpec;workUnits:unknown[]};expect(response.status,JSON.stringify(created)).toBe(200);expect(created.workUnits).toHaveLength(1);expect(created.spec.nodes).toHaveLength(1);
   let completed:{status:string;output?:MediaWorkflowManifest;error?:unknown}|undefined;const end=Date.now()+10000;for(;;){completed=await(await mf.dispatchFetch('https://workflow.test/status?id='+id)).json() as typeof completed;if(completed?.status==='complete')break;if(completed?.status==='errored'||Date.now()>end)throw Error(JSON.stringify(completed));await new Promise(resolve=>setTimeout(resolve,25));}
   const manifest=await(await bucket.get(completed.output!.key))!.json() as MediaWorkflowResult;expect(Object.keys(manifest.artifacts)).toEqual(['unit-0']);const artifacts=manifest.artifacts['unit-0']!;expect(artifacts).toHaveLength(mode==='join'?1:2);
   const {graph,registry,bindings}=complexCommandGraph(mode),command=lowerComplexVideoCommand(planIndependentGraph(graph,registry,'node',complexCommandBudget).workUnits[0]!,bindings,{globalArgs:['-cpuflags','0']});expect(created.spec.nodes[0]!.args).toEqual(command.args);
   writeFileSync(join(directory,'input.raw'),complexCommandInput);const paths=new Map(command.outputs.map((output,index)=>[output.path,join(directory,mode+'-'+index+'.raw')]));execFileSync(binary,command.args.map(value=>value==='/input/video.raw'?join(directory,'input.raw'):paths.get(value)??value),{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
   for(const artifact of artifacts){const object=await bucket.get(artifact.key);expect(object!.etag).toBe(artifact.etag);expect(object!.version).toBe(artifact.version);expect(Buffer.from(await object!.arrayBuffer())).toEqual(readFileSync(paths.get(artifact.path)!));}
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
