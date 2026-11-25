/**
 * Stored Native corpora that keep a generator record: reference-metadata, wav-channel-layout, wav-channel-mask,
 * default-channel-layout and the node-* filesystem corpora. Host-only; never import this into a Worker bundle.
 *
 * - darwin-arm64: <base>/manifest.json ({sha256}) and <base>/provenance.json ({reference, sources, ...}) beside the data
 *   files, as recorded on macOS.
 * - every other pin: <base>/<pin id>/, written by the same tracked generator in the Linux probe corpora job through
 *   tools/differential-runner/platform-corpus.mjs: the data files, sources.json (the generator record without
 *   `reference`), and the platform-corpus manifest.json and provenance.json, whose `reference` is build-metadata.json.
 *
 * selectNativeCorpus returns the corpus of the verified local reference with no fallback (a missing one throws
 * `Missing linux-x64 corpus …`). The darwin-arm64 corpus is verified on every host as labelled evidence of the
 * darwin-arm64 pin, never as the expected output of another platform.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {assertCorpusReference,assertRecordedPin,pinnedReference,platformCorpusDir,readPlatformCorpus,verifyPlatformCorpus} from './reference-identity.js';
import type {RecordedReference} from './reference-identity.js';

export interface NativeCorpusRecord {reference:RecordedReference&{commit?:string};sources:Record<string,string>}
export interface NativeCorpus<R extends NativeCorpusRecord> {
 /** Pin id whose reference recorded the corpus: always the verified local reference. */
 readonly id:string;
 /** Directory holding the data files, manifest.json and the record. */
 readonly dir:string;
 readonly manifest:{readonly sha256:Readonly<Record<string,string>>};
 /** The generator record: provenance.json on darwin-arm64, sources.json plus the platform provenance's reference otherwise. */
 readonly record:R;
 read<T>(file:string):T;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T;

function verifySources(label:string,sources:Record<string,string>,generator:string):void{
 if(sources[generator]===undefined)throw Error(`${label} does not record its generator ${generator}`);
 for(const [path,digest]of Object.entries(sources))if(hash(readFileSync(path))!==digest)throw Error(`${label} source changed: ${path}; regenerate the corpus`);
}

/** The darwin-arm64 corpus at its tracked base, verified as darwin-arm64 evidence independently of the local reference. */
export function darwinNativeCorpus<R extends NativeCorpusRecord>(base:string,generator:string):NativeCorpus<R>{
 const manifest=json<{sha256:Record<string,string>}>(join(base,'manifest.json'));
 for(const [name,digest]of Object.entries(manifest.sha256))if(hash(readFileSync(join(base,name)))!==digest)throw Error(`${base}/${name} differs from its manifest`);
 const record=json<R>(join(base,'provenance.json'));assertRecordedPin(record.reference,'darwin-arm64');
 verifySources(`${base}/provenance.json`,record.sources,generator);
 return {id:'darwin-arm64',dir:base,manifest,record,read:<T>(file:string)=>json<T>(join(base,file))};
}

/**
 * The corpus recorded from this host's pinned reference, written by `generator`. Checks the manifest, the recorded
 * reference against the pin and the local binaries, the tracked sources, and for a platform corpus its provenance
 * (not a draft; the corpora job on a real CPU in the pinned image; this tracked generator).
 */
export function selectNativeCorpus<R extends NativeCorpusRecord>(base:string,generator:string):NativeCorpus<R>{
 const reference=pinnedReference(),darwin=darwinNativeCorpus<R>(base,generator);
 if(reference.id==='darwin-arm64'){assertCorpusReference(darwin.record.reference);return darwin;}
 const provenance=verifyPlatformCorpus(base),dir=platformCorpusDir(base);
 if(provenance.generator.path!==generator||provenance.generator.sha256!==hash(readFileSync(generator)))throw Error(`${dir} was written by another generator than the tracked ${generator}; regenerate it with the linux-corpora job`);
 const record={...readPlatformCorpus<Omit<R,'reference'>>(base,'sources.json'),reference:provenance.reference} as unknown as R;
 assertCorpusReference(record.reference);verifySources(`${dir}/sources.json`,record.sources,generator);
 return {id:reference.id,dir,manifest:json(join(dir,'manifest.json')),record,read:<T>(file:string)=>readPlatformCorpus<T>(base,file)};
}

/** A per-pin table entry, with no fallback to another platform. */
export function forReference<T>(table:Readonly<Record<string,T>>,id:string,what:string):T{
 if(!Object.hasOwn(table,id))throw Error(`No ${id} ${what}; record it from that platform's corpus`);
 return table[id]!;
}
