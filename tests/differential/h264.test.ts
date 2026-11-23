import {it,expect} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {evaluateH264} from '../helpers/h264.js';
import type {H264ExpectedFrame} from '../helpers/h264.js';
import {loadH264Corpus,loadH264Module,h264Hash} from '../helpers/h264-corpus.js';
it('matches native progressive H264 POC and MMCO5 frames with owned planes and int64 clocks',async()=>{
 const rows=loadH264Corpus(),module=new WebAssembly.Module(loadH264Module());
 execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs','h264-frames'],{timeout:30000});
 const directory='.build/oracles/h264-frames/',provenance=JSON.parse(readFileSync(directory+'provenance.json','utf8')) as {binarySha256:string;librarySha256:Record<string,string>};
 const verify=()=>{expect(h264Hash(readFileSync(directory+'native'))).toBe(provenance.binarySha256);for(const [file,digest]of Object.entries(provenance.librarySha256))expect(h264Hash(readFileSync(file))).toBe(digest);};verify();
 for(const row of rows){
  if(row.id.startsWith('moving-')||row.id.startsWith('hd-')){
   const trace=spawnSync('.build/reference/ffmpeg',['-v','info','-f','h264','-i','pipe:0','-c:v','copy','-bsf:v','trace_headers','-f','null','-'],{input:Buffer.concat(row.packets.map(s=>Buffer.from(s,'base64'))),encoding:'utf8',timeout:10000,maxBuffer:4194304});expect(trace.status,row.id+trace.stderr).toBe(0);
   const values=(field:string)=>[...trace.stderr.matchAll(new RegExp('\\b'+field+'\\s+[^\\n]*?=\\s*(-?\\d+)','g'))].map(match=>Number(match[1])),entropy=values('entropy_coding_mode_flag'),direct=values('direct_spatial_mv_pred_flag');
   expect(entropy.length,row.id).toBeGreaterThan(0);expect(entropy.every(value=>value===Number(row.id.includes('-cabac-'))),row.id).toBe(true);
   expect(direct.length,row.id).toBeGreaterThan(0);if(row.id.includes('-spatial-'))expect(direct.every(value=>value===1),row.id).toBe(true);else expect(direct,row.id).toContain(0);
   if(row.id.includes('-high-'))expect(values('transform_8x8_mode_flag'),row.id).toContain(1);
   expect([...trace.stderr.matchAll(/\bluma_weight_l0_flag\[\d+\]\s+[^\n]*?=\s*(\d+)/g)].some(match=>match[1]==='1'),row.id).toBe(true);
  }
  const records:Buffer[]=[];
  for(const [i,encoded]of row.packets.entries()){const bytes=Buffer.from(encoded,'base64'),header=Buffer.alloc(28);header.writeUInt32LE(bytes.length);header.writeBigInt64LE(9007199254740993n+BigInt(i)*1001n,4);header.writeBigInt64LE(BigInt(i)-1n,12);header.writeBigInt64LE(2n,20);records.push(header,bytes);}records.push(Buffer.alloc(4));
  const native=spawnSync(directory+'native',[String(row.initialReorderDelay)],{input:Buffer.concat(records),timeout:10000,maxBuffer:67108864});expect(native.status,row.id+String(native.stderr)).toBe(0);
  const expected:H264ExpectedFrame[]=[];let at=0;
  while(at<native.stdout.length){expect(native.stdout.length-at).toBeGreaterThanOrEqual(44);const header=native.stdout.subarray(at,at+44),size=header.readUInt32LE(24);at+=44;expect(size).toBeLessThanOrEqual(native.stdout.length-at);expected.push({pts:String(header.readBigInt64LE(8)),duration:String(header.readBigInt64LE(16)),width:header.readUInt32LE(0),height:header.readUInt32LE(4),pixelFormat:header.readUInt32LE(28)?'yuvj420p':'yuv420p',colorRange:header.readUInt32LE(32),key:!!header.readUInt32LE(36),type:({1:'I',2:'P',3:'B'} as Record<number,string>)[header.readUInt32LE(40)]!,sha256:h264Hash(native.stdout.subarray(at,at+size))});at+=size;}
  expect(expected,row.id+' frozen Native result').toEqual(row.expected);
  const actual=await evaluateH264(module,row);expect(actual.frames,row.id).toEqual(expected);expect(actual.resetTokens,row.id).toEqual(row.resetTokens);expect(actual.closed).toBe(true);expect([actual.memoryBytes,actual.queuedBytes,actual.pendingPackets]).toEqual([0,0,0]);
 }
 verify();
},30000);
