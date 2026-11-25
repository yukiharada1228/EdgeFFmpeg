import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {assertCorpusReference,pinnedReference,readPlatformCorpus,referencePin,verifyPlatformCorpus} from './reference-identity.js';
import type {RecordedReference} from './reference-identity.js';
/**
 * Pins the BMP evidence: the darwin-arm64 corpus manifest, the pinned upstream sources and test recipes, and the
 * Native reference the tests run. compat/behavior-specs/bmp/provenance.json is the darwin-arm64 record, so its
 * reference must always name the darwin-arm64 pin. With requireReference, the local .build/reference must be the pinned
 * reference of this platform (pinnedReference()), and on darwin-arm64 also the reference that record names.
 */
export function verifyBmpReference(requireReference=true){
 const root='compat/behavior-specs/bmp',hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const [path,digest]of Object.entries(manifest.sha256))if(hash(root+'/'+path)!==digest)throw Error('BMP corpus hash mismatch: '+path);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {commit:string;sources:Record<string,string>;recipes:Record<string,string>;reference:Record<string,string>};
 if(provenance.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('BMP reference commit mismatch');
 for(const [path,digest]of Object.entries({...provenance.sources,...provenance.recipes}))if(hash(path)!==digest)throw Error('BMP source/recipe mismatch: '+path);
 const darwin=referencePin('darwin-arm64').artifacts;
 if(JSON.stringify(provenance.reference)!==JSON.stringify({ffmpeg:darwin.ffmpeg,ffprobe:darwin.ffprobe}))throw Error('BMP darwin-arm64 provenance does not name the darwin-arm64 pin (compat/reference-pins.json)');
 if(!requireReference)return;
 const reference=pinnedReference();
 for(const name of ['ffmpeg','ffprobe'] as const){
  if(hash('.build/reference/'+name)!==reference[name])throw Error('BMP binary mismatch: '+name);
  if(reference.id==='darwin-arm64'&&reference[name]!==provenance.reference[name])throw Error('BMP binary mismatch: '+name);
 }
}

/**
 * The Native default BMP row capacity of the verified local reference, as BmpOptions.rleLineAlignment: a test
 * configuration read from that build, never execution-host detection. libavcodec allocates decoder frames with
 * STRIDE_ALIGN linesizes (libavcodec/internal.h, get_buffer.c and utils.c, pinned in bmp/provenance.json), 64, 32, 16
 * or 8 from HAVE_SIMD_ALIGN_{64,32,16} of its config.h. darwin-arm64 gives 16 (NEON), linux-x64 gives 64 (AVX-512
 * enabled at configure time). config.h must record the pinned configure flags and the pin's architecture.
 */
export function referenceRleLineAlignment():8|16|32|64{
 const reference=pinnedReference(),config=readFileSync('.build/reference/config.h','utf8'),define=(name:string)=>{const match=new RegExp(`^#define ${name} (.+)$`,'m').exec(config);if(!match)throw Error(`.build/reference/config.h has no ${name}`);return match[1]!.trim();};
 if(define('FFMPEG_CONFIGURATION')!==JSON.stringify(reference.metadata.flags.join(' ')))throw Error('.build/reference/config.h does not record the pinned configure flags');
 const arch={x64:'ARCH_X86_64',arm64:'ARCH_AARCH64'}[reference.arch];if(!arch||define(arch)!=='1')throw Error(`.build/reference/config.h is not a ${reference.id} build`);
 return define('HAVE_SIMD_ALIGN_64')==='1'?64:define('HAVE_SIMD_ALIGN_32')==='1'?32:define('HAVE_SIMD_ALIGN_16')==='1'?16:8;
}

export interface BmpRleProfile {alignment:8|16|32|64;depth:number;top:boolean;width:number;seed:number;stride:number;sha256:string}
interface BmpRleOracle {sourceSha256:string;reference:RecordedReference;librarySha256:Record<string,string>}
/**
 * The cached Native RLE profiles of this host's pinned reference: compat/behavior-specs/bmp/rle-profiles.json for
 * darwin-arm64 (pinned by verifyBmpReference), compat/behavior-specs/bmp/<pin id>/ for any other pin, written by
 * tools/differential-runner/bmp-rle/generate.mjs in the Linux probe corpora job. A missing corpus throws; the oracle
 * record must name this pin, the tracked oracle source and, for a platform corpus, the pinned libraries and the tracked
 * generator.
 */
export function readBmpRleProfiles():BmpRleProfile[]{
 const base='compat/behavior-specs/bmp',hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex'),reference=pinnedReference();
 const oracle=readPlatformCorpus<BmpRleOracle>(base,'oracle-provenance.json');assertCorpusReference(oracle.reference);
 if(oracle.sourceSha256!==hash('tools/differential-runner/bmp-rle/oracle.c'))throw Error('BMP RLE corpus oracle source differs from tools/differential-runner/bmp-rle/oracle.c');
 if(reference.id!=='darwin-arm64'){
  const provenance=verifyPlatformCorpus(base),generator='tools/differential-runner/bmp-rle/generate.mjs';
  if(provenance.generator.path!==generator||provenance.generator.sha256!==hash(generator))throw Error(`BMP RLE ${reference.id} corpus was written by another generator than ${generator}; regenerate it with the linux-corpora job`);
  const linked=Object.entries(oracle.librarySha256).map(([path,digest])=>[path.replace(/^\.build\/reference\//,''),digest]).sort(),pinned=Object.entries(reference.libraries).sort();
  if(JSON.stringify(linked)!==JSON.stringify(pinned))throw Error(`BMP RLE ${reference.id} oracle did not link the pinned ${reference.id} libraries`);
 }
 return readPlatformCorpus<BmpRleProfile[]>(base,'rle-profiles.json');
}
