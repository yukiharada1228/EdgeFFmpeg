import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {flacNativeCorpus} from '../helpers/flac-native-corpus.js';
import {assertCorpusReference,pinnedReference,referencePin,verifyPlatformCorpus} from '../helpers/reference-identity.js';
const {corpus,darwin}=flacNativeCorpus('flac-timed-aformat');
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
it('pins the independent timed FLAC aformat oracle and decoder',()=>{
 expect(corpus.rows).toHaveLength(36);expect(hash(wasm)).toBe(corpus.wasmSha256);expect(hash(readFileSync('.build/reference/ffmpeg'))).toBe(corpus.binarySha256);
 // Rows come from this host's pinned reference; the darwin-arm64 rows stay labelled evidence with the same ids.
 expect(corpus.binarySha256).toBe(pinnedReference().ffmpeg);expect(darwin.binarySha256).toBe(referencePin('darwin-arm64').artifacts.ffmpeg);expect(corpus.rows.map(row=>row.id)).toEqual(darwin.rows.map(row=>row.id));
 if(pinnedReference().id!=='darwin-arm64')assertCorpusReference(verifyPlatformCorpus('compat/behavior-specs/flac-timed-aformat'));
});
for(const row of corpus.rows)it(`public timed FLAC aformat matches Native: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let opens=0,commits=0,aborts=0;
 expect(hash(input)).toBe(row.inputSha256);expect(row.exitCode).toBe(0);
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);
 const output=Buffer.concat(chunks);expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);expect({opens,commits,aborts}).toEqual({opens:1,commits:1,aborts:0});
});
const rejected=[
 ['-cpuflags','0','-i','/in.flac','-t','0.001','-af','aformat=sample_fmts=s16,apad=pad_len=7','-ar','16000','-f','s16le','/out'],
 ['-cpuflags','0','-i','/in.flac','-t','0.001','-af','aformat=sample_fmts=s16|flt','-f','s16le','/out'],
 ...['aformat=sample_fmts=s16:sample_rates=16000','aformat=sample_fmts=s16:channel_layouts=mono'].map(filter=>['-cpuflags','0','-i','/in.flac','-t','0.001','-af',filter,'-f','s16le','/out']),
 ...['asetrate=16000','asetrate=8000'].map(filter=>['-cpuflags','0','-i','/in.flac','-t','0.001','-af',filter,'-f','s16le','/out']),
];
for(const [index,args] of rejected.entries())it(`rejects unsupported timed aformat scheduling before publication: ${index}`,async()=>{
 let opens=0;const input=Buffer.from(corpus.rows[0]!.input,'base64');
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Unsupported plan must fail before output');}}});
 const result=await ffmpeg.exec(args);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code,JSON.stringify(result.diagnostics)).toBe(args.some(arg=>arg==='aformat=sample_fmts=s16|flt'||arg.includes('sample_rates=16000')||arg.includes('channel_layouts=mono'))?'execution-failed':'unsupported-command');expect(result.diagnostics[0]?.message).toMatch(/scheduling|scalar|cpuflags|sample format|constraint|rate|layout/i);expect(opens).toBe(0);
});
it('actual Node launcher matches Native timed FLAC aformat',()=>{
 const row=corpus.rows.find(row=>row.args.includes('wav'))??corpus.rows[0]!;
 const root=mkdtempSync(join(tmpdir(),'edge-flac-timed-aformat-'));
 try{writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));const run=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm'),'--',...row.args],{encoding:'utf8',timeout:20000,maxBuffer:1048576});expect(run.error).toBeUndefined();expect(run.signal).toBeNull();expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});const output=readFileSync(join(root,'out'));expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);expect(readdirSync(root).sort()).toEqual(['in.flac','out']);}finally{rmSync(root,{recursive:true,force:true});}
},30000);
