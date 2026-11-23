import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-aformat-rate/cases.json' with {type:'json'};
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
it('pins the independent FLAC aformat-rate oracle and decoder',()=>{
 expect(corpus.rows).toHaveLength(36);expect(corpus.rows.filter(row=>!doubleGap(row.args))).toHaveLength(32);expect(corpus.rows.filter(row=>doubleGap(row.args))).toHaveLength(4);expect(hash(wasm)).toBe(corpus.wasmSha256);expect(hash(readFileSync('.build/reference/ffmpeg'))).toBe(corpus.binarySha256);
});
const doubleGap=(args:readonly string[])=>args.some(arg=>arg==='aformat=sample_fmts=dblp');
for(const row of corpus.rows.filter(row=>!doubleGap(row.args)))it(`public FLAC aformat rate matches Native: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let opens=0,commits=0,aborts=0;
 expect(hash(input)).toBe(row.inputSha256);expect(row.exitCode).toBe(0);
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);
 const output=Buffer.concat(chunks);expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);expect({opens,commits,aborts}).toEqual({opens:1,commits:1,aborts:0});
});
for(const row of corpus.rows.filter(row=>doubleGap(row.args)))it(`records explicit FLAC aformat double FIR precision gap: ${row.id}`,async()=>{
 let opens=0;const input=Buffer.from(row.input,'base64');
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Double FIR gap must fail before output');}}});
 expect(row.exitCode).toBe(0);const result=await ffmpeg.exec(row.args);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(result.diagnostics[0]?.message).toMatch(/double|precision|rounding/i);expect(result.outputs).toEqual([]);expect(opens).toBe(0);
});
const rejected=[
 ['-cpuflags','0','-i','/in.flac','-t','0.001','-af','aformat=f=s16','-ar','16000','-f','framecrc','/out'],
 ['-cpuflags','0','-i','/in.flac','-t','0.001','-af','aformat=f=s16','-ar','16000','-frames:a','1','-f','s16le','/out'],
 ...['aformat=f=s16,apad=pad_len=7','aformat=f=s16,asetrate=8000'].map(filter=>['-cpuflags','0','-i','/in.flac','-t','0.001','-af',filter,'-ar','16000','-f','s16le','/out']),
 ['-i','/in.flac','-af','aformat=f=s16','-ar','16000','-f','s16le','/out'],
];
for(const [index,args] of rejected.entries())it(`rejects unsupported aformat rate scheduling before publication: ${index}`,async()=>{
 let opens=0;const input=Buffer.from(corpus.rows[0]!.input,'base64');
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Unsupported plan must fail before output');}}});
 const result=await ffmpeg.exec(args);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code,JSON.stringify(result.diagnostics)).toBe('unsupported-command');expect(result.diagnostics[0]?.message).toMatch(/scheduling|scalar|cpuflags/i);expect(opens).toBe(0);
});
it('actual Node launcher matches Native FLAC aformat rate',()=>{
 const row=corpus.rows.find(row=>row.args.includes('wav'))??corpus.rows[0]!;
 const root=mkdtempSync(join(tmpdir(),'edge-flac-aformat-rate-'));
 try{writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));const run=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm'),'--',...row.args],{encoding:'utf8',timeout:20000,maxBuffer:1048576});expect(run.error).toBeUndefined();expect(run.signal).toBeNull();expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});const output=readFileSync(join(root,'out'));expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);expect(readdirSync(root).sort()).toEqual(['in.flac','out']);}finally{rmSync(root,{recursive:true,force:true});}
},30000);
