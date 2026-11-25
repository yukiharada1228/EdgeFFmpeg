import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {selectNativeCorpus} from './native-corpus.js';
import type {NativeCorpus,NativeCorpusRecord} from './native-corpus.js';
import {pinnedReference,referencePin,verifyPinnedLibrary} from './reference-identity.js';
export interface DefaultLayoutCase {channels:number;samples:number;kind:string;guess:boolean;format:string;argv:string[];input:string;output:string;sha256:string;exitCode:number}
export interface DefaultLayoutRecord extends NativeCorpusRecord {librarySha256:string;oracleBinarySha256:string;compiler:string;caseCount:number}
export const DEFAULT_LAYOUT_BASE='compat/behavior-specs/default-channel-layout',DEFAULT_LAYOUT_GENERATOR='tools/differential-runner/default-channel-layout/generate.mjs';
const library='libavutil/libavutil.a';
/**
 * The default-layout corpus recorded from this host's pinned reference (selectNativeCorpus), after checking that its
 * oracle linked the libavutil.a pinned for that reference and present locally. The darwin-arm64 record keeps naming the
 * darwin-arm64 libavutil.a pin on every host.
 */
export function defaultLayoutCorpus():NativeCorpus<DefaultLayoutRecord>{
 const corpus=selectNativeCorpus<DefaultLayoutRecord>(DEFAULT_LAYOUT_BASE,DEFAULT_LAYOUT_GENERATOR);
 const darwin=JSON.parse(readFileSync(`${DEFAULT_LAYOUT_BASE}/provenance.json`,'utf8')) as DefaultLayoutRecord;
 if(darwin.librarySha256!==referencePin('darwin-arm64').libraries[library])throw Error('darwin-arm64 default-layout oracle does not record the darwin-arm64 libavutil.a pin');
 if(corpus.record.librarySha256!==pinnedReference().libraries[library]||verifyPinnedLibrary(library)!==corpus.record.librarySha256)throw Error('Native library changed');
 return corpus;
}
/** Host-only verification of fixed Native fixtures;never import this helper into a Worker bundle. */
export function verifiedDefaultLayoutCases():DefaultLayoutCase[]{
 const corpus=defaultLayoutCorpus(),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const rows=corpus.read<DefaultLayoutCase[]>('cases.json');if(rows.length!==512)throw Error('Incomplete default-layout corpus');
 for(const row of rows)if(hash(Buffer.from(row.output,'base64'))!==row.sha256)throw Error('Native output changed');return rows;
}
