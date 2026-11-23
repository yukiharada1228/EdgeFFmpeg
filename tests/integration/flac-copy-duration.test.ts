import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-copy-duration/cases.json' with {type:'json'};

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
for(const row of corpus.rows.filter(row=>row.exitCode===0))it(`public compressed FLAC duration matches Native without a decoder: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let commits=0,aborts=0;
 expect(hash(input)).toBe(row.inputSha256);
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),budget:{maxResidentBytes:2097152,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000},filesystem:{
  async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}};},
  async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}
 }});
 const result=await ffmpeg.exec(row.args);
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(result.diagnostics).toEqual([]);
 const output=Buffer.concat(chunks);expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);
 expect(commits).toBe(1);expect(aborts).toBe(0);
});

// Native's captured process exit is 234 for these invalid values. The public
// execution API retains its own failure exit policy; only rejection and atomic
// prepublication are asserted here, never exact Native error/exit parity.
for(const row of corpus.rows.filter(row=>row.exitCode!==0))it(`compressed FLAC rejects Native-invalid duration without claiming exit-code parity: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64');let opens=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Output must not open');}}});
 const result=await ffmpeg.exec(row.args);
 expect(row.exitCode).toBe(234);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe('invalid-time');expect(result.outputs).toEqual([]);expect(opens).toBe(0);
});

for(const [label,options,code] of [
 ['input seek',['-ss','0.000001','-i','/in.flac'],'unsupported-command'],
 ['output seek',['-i','/in.flac','-ss','0.000001'],'unsupported-command'],
 ['malformed duration',['-i','/in.flac','-t','garbage'],'invalid-time'],
 ['negative duration',['-i','/in.flac','-t','-1'],'invalid-time'],
 ['invalid stop',['-i','/in.flac','-to','0'],'invalid-time']
] as const)it(`compressed FLAC rejects ${label} before output publication`,async()=>{
 const input=Buffer.from(corpus.rows[0]!.input,'base64');let opens=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Output must not open');}}});
 const result=await ffmpeg.exec([...options,'-vn','-c:a','copy','-f','flac','/out']);
 expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe(code);expect(result.outputs).toEqual([]);expect(opens).toBe(0);
});

it('actual Node launcher copies duration-limited FLAC without a Wasm option',()=>{
 const row=corpus.rows.find(row=>row.exitCode===0&&row.args.includes('-t'))!;
 const root=mkdtempSync(join(tmpdir(),'edge-flac-copy-duration-'));
 try{
  writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));
  const run=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...row.args],{encoding:'utf8',timeout:20000,maxBuffer:1048576});
  expect(run.error).toBeUndefined();expect(run.signal).toBeNull();expect(run.status,run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});
  const output=readFileSync(join(root,'out'));expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);
  expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
