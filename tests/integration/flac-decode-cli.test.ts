import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-decode-cli/cases.json' with {type:'json'};
const modulePath=resolve('.build/codecs/flac/edge-flac.wasm');
const selected=['32-2-extremes-5/f64le','32-2-extremes-5/wav','32-2-extremes-5/framecrc'];
const rows=selected.map(id=>{const row=corpus.rows.find(row=>row.id===id);if(!row)throw Error(id);return row;});
function launch(root:string,args:string[],settings:string[]=['--flac-wasm',modulePath]){
 return spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,...settings,'--',...args],{encoding:'utf8',timeout:20000});
}
it('actual launcher decodes magic and explicit FLAC to Native PCM, WAV and framecrc with ordered codec options',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-decode-cli-'));
 try{for(const row of rows){
  writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));
  for(const explicit of [false,true]){
   rmSync(join(root,'out'),{force:true});
   const args=[...(explicit?['-f','flac']:[]),...row.args];
   // A later PCM option overrides an earlier generic copy declaration.
   args.splice(args.length-1,0,'-c','copy',explicit?'-acodec':'-c:a',row.args.includes('pcm_s16le')?'pcm_s16le':row.id.endsWith('/f64le')?'pcm_f64le':'pcm_s16le');
   const result=launch(root,args);
   expect(result.status,row.id+result.stderr).toBe(0);
   expect(readFileSync(join(root,'out')).equals(Buffer.from(row.output!,'base64')),row.id).toBe(true);
   const denied=launch(root,['-n',...args]);expect(denied.status).toBe(0);
   expect(JSON.parse(denied.stdout).diagnostics[0].code).toBe('output-exists');
   expect(readFileSync(join(root,'out')).equals(Buffer.from(row.output!,'base64'))).toBe(true);
  }
 }
 expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('actual launcher rejects missing and unverified modules and preserves output after malformed decode',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-decode-failure-')),row=rows[0]!;
 try{
  const input=Buffer.from(row.input,'base64');writeFileSync(join(root,'in.flac'),input);writeFileSync(join(root,'out'),'sentinel');
  const missing=launch(root,['-y',...row.args],[]);expect(missing.status).not.toBe(0);expect(missing.stderr).toMatch(/FLAC codec module is not configured/);
  const bad=join(root,'wrong.wasm');writeFileSync(bad,Buffer.from([0,97,115,109,1,0,0,0]));
  const wrong=launch(root,row.args,['--flac-wasm',bad]);expect(wrong.status).not.toBe(0);expect(wrong.stderr).toMatch(/FLAC module differs/);
  writeFileSync(join(root,'in.flac'),input.subarray(0,input.length-5));
  const malformed=launch(root,['-y',...row.args]);expect(malformed.status).not.toBe(0);expect(readFileSync(join(root,'out'),'utf8')).toBe('sentinel');
  expect(readdirSync(root).sort()).toEqual(['in.flac','out','wrong.wasm']);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('actual launcher accepts coexisting verified H264 and FLAC modules',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-both-')),row=rows[0]!;
 try{writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));
 const result=launch(root,row.args,['--flac-wasm',modulePath,'--h264-wasm',resolve('.build/codecs/openh264/openh264.wasm')]);
 expect(result.status,result.stderr).toBe(0);expect(readFileSync(join(root,'out')).equals(Buffer.from(row.output!,'base64'))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('retains the probed reader and snapshots FLAC configuration before provider callbacks',async()=>{
 const row=rows[0]!,bytes=Buffer.from(row.input,'base64'),module=new WebAssembly.Module(readFileSync(modulePath)),configuration={module};let opens=0;
 const parts:Uint8Array[]=[];
 const backend=createMediaBackend({flac:configuration});
 const ffmpeg=new FFmpeg({backend,filesystem:{async openRead(){opens++;configuration.module=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(bytes){parts.push(bytes.slice());},async commit(){},async abort(){}};}},budget:{maxBufferBytes:65536,maxResidentBytes:134217728,maxPendingPackets:32,maxCpuTimeMs:10000}});
 const result=await ffmpeg.exec(row.args);expect(result.exitCode,result.diagnostics.map(d=>d.message).join('\n')).toBe(0);expect(opens).toBe(1);expect(Buffer.concat(parts).equals(Buffer.from(row.output!,'base64'))).toBe(true);
});
it('routes a later copy option to FLAC copy without requiring a decoder module',async()=>{
 const copy=await import('../../compat/behavior-specs/flac-cli/cases.json',{with:{type:'json'}}),root=mkdtempSync(join(tmpdir(),'edge-flac-copy-order-'));
 try{writeFileSync(join(root,'input.bin'),Buffer.from(copy.default.input,'base64'));
 const row=copy.default.rows[0]!,args=[...row.args];args.splice(args.length-1,0,'-c:a','pcm_s16le','-c','copy');
 const result=launch(root,args,[]);expect(result.status,result.stderr).toBe(0);expect(readFileSync(join(root,'output.crc'),'utf8')).toBe(row.stdout);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const late of ['resolve','reject'] as const)it(`cancels the frontend probe and observes late ${late}`,async()=>{
 const controller=new AbortController();let ready!:()=>void,resolve!:()=>void,reject!:(reason:unknown)=>void;
 const started=new Promise<void>(done=>{ready=done;}),pending=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
 let writes=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),filesystem:{async openRead(){ready();await pending;return {size:4n,async readAt(){return new Uint8Array([102,76,97,67]);}};},async openWrite(){writes++;throw Error('unexpected writer');}}});
 const task=ffmpeg.exec(rows[0]!.args,{signal:controller.signal});await started;controller.abort(Error('stop probe'));
 expect((await task).exitCode).not.toBe(0);expect(writes).toBe(0);
 if(late==='resolve')resolve();else reject(Error('late open failure'));
 await new Promise<void>(done=>setTimeout(done,0));expect(writes).toBe(0);
});
it('preserves undeclared WAV PCM routing and reuses its probed source',async()=>{
 const wav=rows[1]!,raw=corpus.rows.find(row=>row.id==='32-2-extremes-5/s16le')!,bytes=Buffer.from(wav.output!,'base64'),parts:Uint8Array[]=[];let opens=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),filesystem:{async openRead(){if(++opens!==1)throw Error('source reopened');return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(bytes){parts.push(bytes.slice());},async commit(){},async abort(){}};}}});
 const result=await ffmpeg.exec(['-i','/input.wav','-f','s16le','/output']);expect(result.exitCode,result.diagnostics.map(d=>d.message).join('\n')).toBe(0);expect(opens).toBe(1);expect(Buffer.concat(parts).equals(Buffer.from(raw.output!,'base64'))).toBe(true);
});
