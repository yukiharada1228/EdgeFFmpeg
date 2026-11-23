import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
export interface ReferencePixelBuild {readonly platform:string;readonly arch:string;readonly flags:readonly string[]}
/** Test configuration for the recorded oracle, never execution-host autodetection. */
export function selectReferencePixelArithmetic(reference:ReferencePixelBuild):PixelArithmetic{
 if(reference.platform==='darwin'&&reference.arch==='arm64')return 'aarch64';
 if(reference.platform==='linux'&&reference.arch==='x64'&&reference.flags.includes('--disable-x86asm'))return 'x86_64';
 throw new Error('Unverified default pixel arithmetic for reference build');
}
export function referencePixelArithmetic():PixelArithmetic{
 const reference=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as ReferencePixelBuild&{commit:string;artifacts:{ffmpeg:string}};
 const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string;configureFile:string};
 const flags=readFileSync(lock.configureFile,'utf8').trim().split(/\s+/),sha256=createHash('sha256').update(readFileSync('.build/reference/ffmpeg')).digest('hex');
 if(reference.commit!==lock.commit||JSON.stringify(reference.flags)!==JSON.stringify(flags)||reference.artifacts.ffmpeg!==sha256)throw new Error('Invalid reference pixel build provenance');
 return selectReferencePixelArithmetic(reference);
}
