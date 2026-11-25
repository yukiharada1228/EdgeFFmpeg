/**
 * Pinned Native reference identity for tests. Every test that compares Edge with the local .build/reference, or with
 * a stored corpus recorded from a reference, resolves that reference through pinnedReference() and never through a
 * hash literal. The interface is fixed (docs/contributing/linux-reference.md); later work builds on it.
 *
 * - pinnedReference(): the verified local reference. Throws unless build-metadata.json matches
 *   compat/upstream.lock.json, compat/configure.flags and this host, the binaries match build-metadata.json, and the
 *   binaries equal exactly the compat/reference-pins.json entry for that platform.
 * - referencePin(id): one pin, read-only, for platform-independent checks of tracked evidence.
 * - platformCorpusDir(base) / readPlatformCorpus(base, file): the corpus for the verified reference, no fallback.
 * - assertCorpusReference(recorded): a stored record names the verified pin.
 * - requireGeneratedInput(path, how): a git-ignored generated input, or an actionable error.
 */
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {LEGACY_CORPUS_PLATFORM,PINS_FILE,assertRecordedPin as assertRecordedPinIn,loadReferencePins,localReferenceIdentity,platformCorpusDirFor,referencePinFrom,resolveReferenceIdentity,sha256File} from '../../tools/differential-runner/reference-identity.mjs';
import type {RecordedCorpusProvenance,RecordedReference,ReferenceIdentity,ReferenceInputs,ReferencePin,ReferencePins} from '../../tools/differential-runner/reference-identity.mjs';
import {verifyPlatformCorpusDir} from '../../tools/differential-runner/platform-corpus.mjs';
import type {PlatformCorpusProvenance} from '../../tools/differential-runner/platform-corpus.mjs';
export type {BuildMetadata,RecordedCorpusProvenance,RecordedReference,ReferenceArtifacts,ReferenceInputs,ReferencePin,ReferencePins} from '../../tools/differential-runner/reference-identity.mjs';
export type {PlatformCorpusProvenance} from '../../tools/differential-runner/platform-corpus.mjs';

/** The verified local reference: {id, platform, arch, ffmpeg, ffprobe, libraries, metadata, pin}. */
export type PinnedReference=ReferenceIdentity;
export const REFERENCE_PINS_FILE=PINS_FILE;
export const LINUX_CORPUS_HINT='generate it with the linux-corpora job (docs/contributing/linux-reference.md)';

let pins:ReferencePins|undefined,local:PinnedReference|undefined;
const loadedPins=()=>pins??=loadReferencePins();

/**
 * Resolves the local .build/reference once per test file. Throws, for example,
 * `Reference linux-x64 ffmpeg 58295ca5… is not the pinned 5e43da9a… (compat/reference-pins.json)` or
 * `No pinned Native reference for linux-arm64 (compat/reference-pins.json)`.
 */
export function pinnedReference():PinnedReference{return local??=localReferenceIdentity();}

/** Pure resolution of injected inputs, for unit tests of the identity rules. */
export function resolvePinnedReference(inputs:ReferenceInputs):PinnedReference{return resolveReferenceIdentity(inputs);}

/** One pin by id, without looking at the local reference. */
export function referencePin(id:string):ReferencePin{return referencePinFrom(loadedPins(),id);}
export function referencePinIds():readonly string[]{return Object.keys(loadedPins().platforms).sort();}

/** sha256 of .build/reference/<path> after checking it equals the pinned library hash, e.g. 'libavutil/libavutil.a'. */
export function verifyPinnedLibrary(path:string):string{
 const reference=pinnedReference(),expected=reference.libraries[path];
 if(!expected)throw new Error(`No pinned ${reference.id} library ${path} (${PINS_FILE})`);
 const actual=sha256File(join('.build/reference',path));
 if(actual!==expected)throw new Error(`Reference ${reference.id} ${path} ${actual.slice(0,8)}… is not the pinned ${expected.slice(0,8)}… (${PINS_FILE})`);
 return actual;
}

/** base for darwin-arm64, base/linux-x64 for linux-x64; any other id throws. */
export function platformCorpusDir(base:string,id:string=pinnedReference().id):string{return platformCorpusDirFor(base,id,loadedPins());}

/** A stored record ({platform, arch, artifacts} or a platform-corpus provenance) names the pin `id`; independent of the local reference. */
export function assertRecordedPin(recorded:RecordedReference|RecordedCorpusProvenance,id:string):ReferencePin{return assertRecordedPinIn(recorded,id,loadedPins());}

/** A stored record names the verified local pin: recorded platform, arch and ffmpeg (and ffprobe when recorded) equal the pin and the local binaries. */
export function assertCorpusReference(recorded:RecordedReference|RecordedCorpusProvenance):PinnedReference{
 const reference=pinnedReference();assertRecordedPinIn(recorded,reference.id,loadedPins());return reference;
}

const verifiedCorpora=new Map<string,PlatformCorpusProvenance>();
/**
 * Verifies a <base>/<id>/ corpus written by tools/differential-runner/platform-corpus.mjs (manifest, provenance, pin,
 * not a draft) and returns its provenance. darwin-arm64 corpora keep their tracked layout and their own checks.
 */
export function verifyPlatformCorpus(base:string,id:string=pinnedReference().id):PlatformCorpusProvenance{
 if(id===LEGACY_CORPUS_PLATFORM)throw new Error(`${LEGACY_CORPUS_PLATFORM} corpora keep their tracked layout in ${base}; verify them with their own checks`);
 const dir=platformCorpusDir(base,id),cached=verifiedCorpora.get(dir);if(cached)return cached;
 if(!existsSync(join(dir,'provenance.json')))throw new Error(`Missing ${id} corpus ${dir}; ${LINUX_CORPUS_HINT}`);
 const provenance=verifyPlatformCorpusDir(dir,id,{pins:loadedPins()});
 if(id===pinnedReference().id)assertCorpusReference(provenance);
 verifiedCorpora.set(dir,provenance);return provenance;
}

/** Reads <platformCorpusDir(base)>/<file> as JSON, verifying a non-darwin corpus first; a missing corpus throws. */
export function readPlatformCorpus<T=unknown>(base:string,file:string,id:string=pinnedReference().id):T{
 const dir=platformCorpusDir(base,id),path=join(dir,file);
 if(id!==LEGACY_CORPUS_PLATFORM)verifyPlatformCorpus(base,id);
 if(!existsSync(path))throw new Error(`Missing ${id} corpus ${path}; ${id===LEGACY_CORPUS_PLATFORM?'it is tracked evidence, restore it from git':LINUX_CORPUS_HINT}`);
 return JSON.parse(readFileSync(path,'utf8')) as T;
}

/** Bytes of a git-ignored generated input, or `Missing generated input <path>; run <how>`. */
export function requireGeneratedInput(path:string,how:string):Buffer{
 if(!existsSync(path))throw new Error(`Missing generated input ${path}; run ${how}`);
 return readFileSync(path);
}
