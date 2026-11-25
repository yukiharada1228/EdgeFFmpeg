/**
 * Stored Native FLAC transform corpora (compat/behavior-specs/flac-*), selected by the verified local reference.
 * darwin-arm64 rows stay in <base>/<file>; every other pin reads <base>/<pin id>/<file>, written by the corpus's
 * tracked generator in the Linux probe corpora job (tools/differential-runner/platform-corpus.mjs). There is no
 * fallback: a missing platform corpus throws `Missing linux-x64 corpus …`. The darwin-arm64 rows are also checked on
 * every host as labelled evidence of the darwin-arm64 pin, never as the expected output of another platform.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pinnedReference,readPlatformCorpus,referencePin,verifyPlatformCorpus} from './reference-identity.js';

export interface FlacNativeRow {
 id:string;input:string;inputSha256:string;args:string[];referenceArgs?:string[];exitCode:number;
 stdout?:string;stderr:string;output:string|null;outputSha256:string|null;
}
export interface FlacNativeCorpus {reference:string;binarySha256:string;wasmSha256:string;rows:FlacNativeRow[]}
export interface FlacCorpusSelection {
 /** Rows recorded from this host's pinned reference. */
 readonly corpus:FlacNativeCorpus;
 /** The tracked darwin-arm64 rows, for platform-independent checks only. */
 readonly darwin:FlacNativeCorpus;
 /** Directory the rows were read from. */
 readonly dir:string;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/**
 * The rows of compat/behavior-specs/<name>/<file> for this host's pin. Checks that the darwin-arm64 file records the
 * darwin-arm64 pin, that the selected file records the local pin, and for a platform corpus its manifest, provenance
 * (corpora job, real CPU, pinned image) and that it was written by tools/differential-runner/<name>/generate.mjs as tracked.
 */
export function flacNativeCorpus(name:string,file='cases.json'):FlacCorpusSelection{
 const base=`compat/behavior-specs/${name}`,generator=`tools/differential-runner/${name}/generate.mjs`,reference=pinnedReference();
 const darwin=JSON.parse(readFileSync(`${base}/${file}`,'utf8')) as FlacNativeCorpus;
 if(darwin.binarySha256!==referencePin('darwin-arm64').artifacts.ffmpeg)throw Error(`${base}/${file} is darwin-arm64 evidence but records ffmpeg ${darwin.binarySha256}`);
 if(reference.id==='darwin-arm64')return {corpus:darwin,darwin,dir:base};
 const provenance=verifyPlatformCorpus(base);
 if(provenance.generator.path!==generator||provenance.generator.sha256!==hash(readFileSync(generator)))throw Error(`${base}/${reference.id} was written by another generator than the tracked ${generator}; regenerate it with the linux-corpora job`);
 const corpus=readPlatformCorpus<FlacNativeCorpus>(base,file);
 if(corpus.binarySha256!==reference.ffmpeg)throw Error(`${base}/${reference.id}/${file} records ffmpeg ${corpus.binarySha256}, not the pinned ${reference.id} ${reference.ffmpeg}`);
 return {corpus,darwin,dir:`${base}/${reference.id}`};
}
