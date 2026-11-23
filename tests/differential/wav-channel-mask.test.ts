import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {openWav,muxWav} from '@edge-ffmpeg/containers';import type {WavPcmCodec} from '@edge-ffmpeg/containers';import {memoryInput} from '../helpers/wav.js';import {collectingOutput} from '../helpers/output.js';
it('matches Native default-compliance WAV channel-mask serialization without changing declared input layout',async()=>{
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const base='compat/behavior-specs/wav-channel-mask/';
 const manifest=JSON.parse(readFileSync(base+'manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const [name,digest] of Object.entries(manifest.sha256))expect(hash(readFileSync(base+name))).toBe(digest);
 const provenance=JSON.parse(readFileSync(base+'provenance.json','utf8')) as {sources:Record<string,string>;caseCount:number};
 expect(provenance.caseCount).toBe(14);for(const [path,digest] of Object.entries(provenance.sources))expect(hash(readFileSync(path))).toBe(digest);
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/wav-channel-mask/cases.json','utf8')) as {reference:{artifacts:Record<string,string>};rows:{mask:number;channels:number;samples:number;exitCode:number;input:string;output:string;sha256:string}[]};
 for(const name of ['ffmpeg','ffprobe'])expect(createHash('sha256').update(readFileSync('.build/reference/'+name)).digest('hex')).toBe(fixture.reference.artifacts[name]);expect(fixture.rows).toHaveLength(14);
 for(const row of fixture.rows){expect(hash(Buffer.from(row.output,'base64'))).toBe(row.sha256);expect(row.exitCode).toBe(0);const source=await openWav(memoryInput(Buffer.from(row.input,'base64')),{maxReadBytes:Math.max(8,row.channels*2)}),sink=collectingOutput();expect(source.info.channelMask).toBe(row.mask);
  await muxWav(sink.output,{codec:source.info.codec as WavPcmCodec,sampleRate:source.info.sampleRate,channels:source.info.channels,channelMask:source.info.channelMask},source.packets(),{sampleCount:source.info.durationSamples,maxWriteBytes:3,metadataProfile:'ffmpeg-9.0.2',bitexact:true});
  expect(Buffer.from(sink.bytes()),String(row.mask)+'/'+row.samples).toEqual(Buffer.from(row.output,'base64'));expect(sink.lengths.every(n=>n<=3)).toBe(true);expect(sink.committed).toBe(true);
 }
});

it('matches Native high-mask WAV stream-copy bytes through the actual Node launcher',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'),{join}=await import('node:path'),{spawnSync}=await import('node:child_process');
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/wav-channel-mask/cases.json','utf8')) as {rows:{input:string;output:string;mask:number;samples:number}[]};
 expect(fixture.rows).toHaveLength(14);const root=mkdtempSync(join(tmpdir(),'wav-mask-cli-'));
 try {for(const row of fixture.rows){
  writeFileSync(join(root,'input.wav'),Buffer.from(row.input,'base64'));
  const result=spawnSync(process.execPath,['tools/cli/run.mjs','--root',root,'--','-y','-i','/input.wav','-c:a','copy','-bitexact','/output.wav'],{encoding:'utf8',timeout:15000});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  const summary=JSON.parse(result.stdout);expect(summary.diagnostics).toEqual([]);expect(summary.outputs).toEqual(['/output.wav']);
  expect(readFileSync(join(root,'output.wav')),String(row.mask)+'/'+row.samples).toEqual(Buffer.from(row.output,'base64'));
 }}finally{rmSync(root,{recursive:true,force:true});}
},30000);
