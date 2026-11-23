import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {FFmpeg} from '@edge-ffmpeg/core';
import {executeFlacDecode} from '../../packages/avformat/src/flac-decode.js';
import corpus from '../../compat/behavior-specs/flac-decode-cli/cases.json' with {type:'json'};
it('bundles the production decoder route without Node, Native or build paths',async()=>{
 const result=await build({entryPoints:['packages/avformat/src/flac-decode.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('.build/')||path.includes('runtime-node'))).toBe(false);
 expect(result.outputFiles[0]!.text).not.toMatch(/node:|child_process|\.build\//);
});
for(const late of ['resolve','reject'] as const)it(`cancels stalled output and observes late ${late}`,async()=>{
 const module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm')),row=corpus.rows.find(row=>row.id==='32-2-extremes-5/f64le')!,bytes=Buffer.from(row.input,'base64'),controller=new AbortController();
 let ready!:()=>void,resolve!:()=>void,reject!:(reason:unknown)=>void,commits=0,aborts=0;
 const started=new Promise<void>(done=>{ready=done;}),pending=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
 const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module})},budget:{maxBufferBytes:1024,maxResidentBytes:33554432,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(){ready();await pending;},async commit(){commits++;},async abort(){aborts++;}};}}});
 const task=ffmpeg.exec(row.args,{signal:controller.signal});await started;controller.abort(Error('cancel stalled writer'));
 const result=await task;expect(result.exitCode).not.toBe(0);expect(commits).toBe(0);
 if(late==='resolve')resolve();else reject(Error('late writer failure'));
 await new Promise<void>(done=>setTimeout(done,0));expect(aborts).toBeGreaterThan(0);expect(commits).toBe(0);
});
