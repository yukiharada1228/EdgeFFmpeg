import {nativeWavOutput} from '../helpers/native-wav.js';
import {openWav} from '@edge-ffmpeg/containers';
import {memoryInput} from '../helpers/wav.js';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { chunk, riff, pcmFormat } from '../helpers/wav.js';
async function wavPayload(bytes:Uint8Array){const wav=await openWav(memoryInput(bytes),{maxReadBytes:8}),parts:number[]=[];for await(const packet of wav.packets())parts.push(...packet.data);return parts;}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'edgeffmpeg-cli-')); roots.push(root);
  const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0,3,0]))]);
  await writeFile(join(root, 'input.wav'), bytes);
  const filesystem = await createNodeFileSystem({ root, maxReadBytes: 8, maxWriteBytes: 8, overwrite: true });
  const ffmpeg = new FFmpeg({ filesystem, backend: createWavBackend(), budget: { maxResidentBytes: 1024, maxBufferBytes: 8, maxCpuTimeMs: 1000, maxPendingPackets: 2 } });
  return { root, bytes, ffmpeg };
}
it('executes FFmpeg-style argv and returns the committed output', async () => {
  const { root, bytes, ffmpeg } = await fixture();
  const result = await ffmpeg.exec(['-hide_banner', '-f', 'wav', '-i', '/input.wav', '-map', '0:a:0', '-c:a', 'copy', '-f', 'wav', '/output.wav']);
  expect(result).toEqual({ exitCode: 0, outputs: ['/output.wav'], diagnostics: [] });
  expect(new Uint8Array(await readFile(join(root, 'output.wav')))).toEqual(nativeWavOutput(bytes));
  expect((await readdir(root)).sort()).toEqual(['input.wav', 'output.wav']);
});
it('honors per-command -n and -y independently of the adapter default', async () => {
  const { root, bytes, ffmpeg } = await fixture(); await writeFile(join(root, 'output.wav'), 'old');
  for (const flag of ['-n', null]) {
    const result = await ffmpeg.exec([...(flag ? [flag] : []), '-i', '/input.wav', '-c', 'copy', '/output.wav']);
    await writeFile(join(root,'native.wav'),'native-old');const native=spawnSync('.build/reference/ffmpeg',['-v','error',...(flag?[flag]:[]),'-i',join(root,'input.wav'),'-c','copy',join(root,'native.wav')],{encoding:'utf8',timeout:10000,input:''});expect(native.signal).toBeNull();expect(native.status,native.stderr).toBe(0);expect(await readFile(join(root,'native.wav'),'utf8')).toBe('native-old');await rm(join(root,'native.wav'));
    expect(result.exitCode).toBe(native.status);expect(result.outputs).toEqual([]);expect(result.diagnostics[0]?.code).toBe('output-exists');expect(await readFile(join(root, 'output.wav'), 'utf8')).toBe('old');
  }
  expect((await ffmpeg.exec(['-y', '-i', '/input.wav', '-c', 'copy', '/output.wav'])).exitCode).toBe(0);
  expect(new Uint8Array(await readFile(join(root, 'output.wav')))).toEqual(nativeWavOutput(bytes));
  expect((await readdir(root)).sort()).toEqual(['input.wav', 'output.wav']);
});
it('rejects invalid input without creating an output transaction', async () => {
  const { root, ffmpeg } = await fixture(); await writeFile(join(root, 'input.wav'), 'broken');
  const result = await ffmpeg.exec(['-i', '/input.wav', '-c', 'copy', '/output.wav']);
  expect(result.exitCode).toBe(1); expect(result.outputs).toEqual([]); expect(await readdir(root)).toEqual(['input.wav']);
});

it('runs the development CLI launcher as a real Node process', async () => {
  const { root, bytes } = await fixture();
  const result = spawnSync(process.execPath, ['tools/cli/run.mjs', '--root', root, '--', '-i', '/input.wav', '-c', 'copy', '/launcher.wav'], { encoding: 'utf8', timeout: 30000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ exitCode: 0, outputs: ['/launcher.wav'], diagnostics: [] });
  expect(new Uint8Array(await readFile(join(root, 'launcher.wav')))).toEqual(nativeWavOutput(bytes));
  const failure = spawnSync(process.execPath, ['tools/cli/run.mjs', '--root', root, '--', '-i', '/input.wav', '-c', 'aac', '/invalid.wav'], { encoding: 'utf8', timeout: 30000 });
  expect(failure.status).toBe(1); expect(JSON.parse(failure.stderr).diagnostics[0].code).toBe('unsupported-command');
  expect((await readdir(root)).sort()).toEqual(['input.wav', 'launcher.wav']);
});

it('rejects unpinned floating-to-integer conversion before creating output', async () => {
  const { root, ffmpeg } = await fixture();
  const format = pcmFormat(1,8000,32); new DataView(format.buffer).setUint16(0,3,true);
  await writeFile(join(root,'input.wav'), riff([chunk('fmt ',format),chunk('data',new Uint8Array(4))]));
  const result = await ffmpeg.exec(['-i', '/input.wav', '-c:a', 'pcm_s16le', '/unsupported.wav']);
  expect(result.exitCode).toBe(1); expect(result.diagnostics[0]?.code).toBe('unsupported-command');
  expect(await readdir(root)).toEqual(['input.wav']);
});

it('aborts staged output when a later floating packet contains an unsupported value', async () => {
  const { root, ffmpeg }=await fixture();
  const format=new Uint8Array(18); format.set(pcmFormat(1,8000,32)); new DataView(format.buffer).setUint16(0,3,true);
  const data=new Uint8Array(12), view=new DataView(data.buffer); view.setFloat32(0,0.5,true); view.setFloat32(4,0,true); view.setFloat32(8,NaN,true);
  await writeFile(join(root,'input.wav'),riff([chunk('fmt ',format),chunk('data',data)]));
  const result=await ffmpeg.exec(['-cpuflags','0','-i','/input.wav','-c:a','pcm_s16le','/failed.wav']);
  expect(result.exitCode).toBe(1); expect(result.diagnostics[0]?.message).toContain('Non-finite');
  expect(await readdir(root)).toEqual(['input.wav']);
});

it('rejects invalid/unsupported seek requests without creating output', async () => {
  const {root,ffmpeg}=await fixture();
  for(const args of [
    ['-ss','1','-i','/input.wav','-c','copy','/failed.wav'],
    ['-i','/input.wav','-ss','0.1','-to','0.1','-c','copy','/failed.wav'],
    ['-i','/input.wav','-t','.5','-c','copy','/failed.wav']
  ]) {expect((await ffmpeg.exec(args)).exitCode).toBe(1);expect(await readdir(root)).toEqual(['input.wav']);}
});
it('commits an empty WAV for an output seek beyond EOF', async () => {
  const {root,bytes:input,ffmpeg}=await fixture();
  expect((await ffmpeg.exec(['-i','/input.wav','-ss','1','-c:a','pcm_s16le','/empty.wav'])).exitCode).toBe(0);
  const bytes=await readFile(join(root,'empty.wav'));expect(new Uint8Array(bytes)).toEqual(nativeWavOutput(input,['-ss','1','-c:a','pcm_s16le']));expect(await wavPayload(bytes)).toEqual([]);
});

it('executes an ordered filter chain and honors the last audio-filter option',async()=>{
  const {root,bytes:input,ffmpeg}=await fixture();
  const result=await ffmpeg.exec(['-cpuflags','0','-i','/input.wav','-af','volume=0.25','-filter:a','anull,volume=0.5:precision=double,anull','-c:a','pcm_s16le','/filtered.wav']);
  expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
  const data=await readFile(join(root,'filtered.wav'));expect(new Uint8Array(data)).toEqual(nativeWavOutput(input,['-af','volume=0.25','-filter:a','anull,volume=0.5:precision=double,anull','-c:a','pcm_s16le'],['-cpuflags','0']));expect(await wavPayload(data)).toEqual([0,0,1,0,2,0]);
});
it('requires scalar rounding for volume-to-integer output and aborts on later non-finite filter input',async()=>{
  const {root,ffmpeg}=await fixture();
  expect((await ffmpeg.exec(['-i','/input.wav','-af','volume=0.5','-c:a','pcm_s16le','/unprofiled.wav'])).diagnostics[0]?.code).toBe('unsupported-command');
  const format=new Uint8Array(18);format.set(pcmFormat(1,8000,32));new DataView(format.buffer).setUint16(0,3,true);
  const samples=new Uint8Array(12),view=new DataView(samples.buffer);view.setFloat32(0,0.5,true);view.setFloat32(4,0.25,true);view.setFloat32(8,NaN,true);
  await writeFile(join(root,'input.wav'),riff([chunk('fmt ',format),chunk('data',samples)]));
  const failed=await ffmpeg.exec(['-i','/input.wav','-af','volume=0.5','-c:a','pcm_f32le','/failed.wav']);
  expect(failed.exitCode).toBe(1);expect(failed.diagnostics[0]?.message).toContain('Non-finite');expect(await readdir(root)).toEqual(['input.wav']);
});
it('selects WAV/raw default encoders and rejects unsupported format/rate changes before output',async()=>{
  const {root,ffmpeg}=await fixture();await writeFile(join(root,'unsigned.raw'),new Uint8Array([0,128,255]));
  const result=await ffmpeg.exec(['-f','u8','-i','/unsigned.raw','/default.wav']);expect(result.exitCode).toBe(0);
  const output=await readFile(join(root,'default.wav')),input=riff([chunk('fmt ',pcmFormat(1,44100,8)),chunk('data',new Uint8Array([0,128,255]))]);expect(new Uint8Array(output)).toEqual(nativeWavOutput(input,['-c:a','pcm_s16le']));expect(await wavPayload(output)).toEqual([0,128,0,0,0,127]);
  expect((await ffmpeg.exec(['-i','/input.wav','-f','s16le','/default.raw'])).exitCode).toBe(0);expect([...await readFile(join(root,'default.raw'))]).toEqual([1,0,2,0,3,0]);
  for(const args of [
    ['-i','/input.wav','-c:a','copy','-f','f32le','/bad.raw'],
    ['-f','u8','-ar','0','-i','/unsigned.raw','-f','s16le','/bad.raw'],
    ['-f','u8','-ar','8000','-i','/unsigned.raw','-ar','48000','-f','s16le','/bad.raw'],
    ['-f','u8','-i','/unsigned.raw','-ac','3','-f','s16le','/bad.raw']
  ]){expect((await ffmpeg.exec(args)).exitCode).toBe(1);}
  expect((await readdir(root)).sort()).toEqual(['default.raw','default.wav','input.wav','unsigned.raw']);
});
it('runs integer fixed volume without scalar flags and rejects unpinned mixed float-to-fixed conversion',async()=>{
  const {root,ffmpeg}=await fixture();
  const fixed=await ffmpeg.exec(['-i','/input.wav','-af','volume=0.5:precision=fixed','-f','s16le','/fixed.raw']);expect(fixed.exitCode,JSON.stringify(fixed.diagnostics)).toBe(0);expect([...await readFile(join(root,'fixed.raw'))]).toEqual([1,0,1,0,2,0]);
  const mixed=await ffmpeg.exec(['-i','/input.wav','-af','volume=0.5,volume=0.5:precision=fixed','-c:a','pcm_f32le','/mixed.wav']);expect(mixed.exitCode).toBe(1);expect(mixed.diagnostics[0]?.code).toBe('unsupported-command');
  expect((await readdir(root)).sort()).toEqual(['fixed.raw','input.wav']);
});
