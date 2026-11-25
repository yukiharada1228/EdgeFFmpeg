import {loadLauncher} from './launcher-cache.mjs';
import { resolve } from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const args = process.argv.slice(2);
const separator=args.indexOf('--'),settings={};let valid=separator>=0;
for(let i=0;valid&&i<separator;i+=2){if(!['--root','--h264-wasm','--flac-wasm'].includes(args[i])||!args[i+1]||i+1>=separator||settings[args[i]])valid=false;else settings[args[i]]=args[i+1];}
if (!valid || !settings['--root']) {
  console.error('Usage: npm run ffmpeg -- --root <directory> [--h264-wasm <verified module>] [--flac-wasm <verified module>] -- <FFmpeg arguments>');
  process.exitCode = 2;
} else {
  try {
    let codecModule;
    if(settings['--h264-wasm']){
      const path=resolve(settings['--h264-wasm']),info=await stat(path);
      if(!info.isFile()||info.size<8||info.size>1048576)throw Error('Invalid H264 module file size');
      const bytes=await readFile(path),lock=JSON.parse(await readFile(resolve(import.meta.dirname,'../codecs/openh264/build.lock.json'),'utf8'));
      if(createHash('sha256').update(bytes).digest('hex')!==lock.expectedWasmSha256)throw Error('H264 module differs from pinned verified codec');
      codecModule=await WebAssembly.compile(bytes);
    }
    let flacModule;
    if(settings['--flac-wasm']){
      const path=resolve(settings['--flac-wasm']),info=await stat(path);
      if(!info.isFile()||info.size<8||info.size>1048576)throw Error('Invalid FLAC module file size');
      const bytes=await readFile(path),lock=JSON.parse(await readFile(resolve(import.meta.dirname,'../codecs/flac/inputs.json'),'utf8'));
      if(bytes.length>1048576||bytes.length!==lock.wasmBytes||createHash('sha256').update(bytes).digest('hex')!==lock.wasmSha256)throw Error('FLAC module differs from pinned verified codec');
      flacModule=await WebAssembly.compile(bytes);
    }
    const {launcher} = await loadLauncher(`
        import { FFmpeg } from '@edge-ffmpeg/core';
        import { createMediaBackend } from '@edge-ffmpeg/avformat';
        import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
        export async function run(root, argv, remixArithmetic = 'separate', pixelArithmetic = 'aarch64', module, flacModule, numericProfile) {
          const h264=module?{module,maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384}:undefined;
          const flac=flacModule?{module:flacModule,maxReadBytes:65536,maxFrameBytes:4194304}:undefined;
          const filesystem = await createNodeFileSystem({ root, maxReadBytes: (module||flacModule)?1048576:65536, maxWriteBytes: (module||flacModule)?1048576:65536 });
          const budget=(module||flacModule)?{maxResidentBytes:134217728,maxBufferBytes:1048576,maxPendingPackets:32,maxCpuTimeMs:60000}:undefined;
          return new FFmpeg({ filesystem, backend: createMediaBackend({ remixArithmetic, pixelArithmetic,...(numericProfile?{numericProfile}:{}),...(h264?{h264}:{}),...(flac?{flac}:{}) }),...(budget?{budget}:{}) }).exec(argv);
        }`);
    const result = await launcher.run(settings['--root'], args.slice(separator+1), process.env.EDGEFFMPEG_REMIX_ARITHMETIC ?? 'separate', process.env.EDGEFFMPEG_PIXEL_ARITHMETIC ?? 'aarch64',codecModule,flacModule,process.env.EDGEFFMPEG_NUMERIC_PROFILE);
    const summary = JSON.stringify({ exitCode: result.exitCode, outputs: result.outputs, diagnostics: result.diagnostics, effects: result.error?.effects });
    (result.exitCode === 0 ? process.stdout : process.stderr).write(summary + '\n');
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
