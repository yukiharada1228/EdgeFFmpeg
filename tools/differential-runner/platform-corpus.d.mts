import type {BuildMetadata,ReferenceIdentity,ReferencePins} from './reference-identity.mjs';
export interface ExecutionEnvironment {
 readonly platform:string;readonly arch:string;readonly node:string;readonly kernel:string;readonly kernelVersion:string;
 readonly cpuModel:string;readonly emulated:boolean;readonly emulation:string|null;readonly uid:number|null;readonly unprivileged:boolean;
}
export interface CiRecord {
 readonly provider:'github-actions';readonly repository:string|null;readonly workflow:string|null;readonly job:string|null;
 readonly runId:string|null;readonly runAttempt:string|null;readonly sha:string|null;readonly ref:string|null;readonly runnerName:string|null;
}
export interface PlatformCorpusProvenance {
 readonly schema:'edge-ffmpeg/platform-corpus@1';readonly referenceId:string;
 readonly pin:{readonly file:string;readonly ffmpeg:string;readonly ffprobe:string;readonly source:string;readonly image:string|null};
 readonly reference:BuildMetadata;readonly generator:{readonly path:string;readonly sha256:string};readonly image:string|null;
 readonly environment:ExecutionEnvironment;readonly ci:CiRecord|null;readonly draft:boolean;readonly generatedAt:string;
}
export interface CorpusTarget {
 readonly id:string;readonly base:string;readonly dir:string;readonly draft:boolean;readonly legacyLayout:boolean;
 readonly provenance:PlatformCorpusProvenance;readonly identity:ReferenceIdentity;
}
export const PROVENANCE_SCHEMA:'edge-ffmpeg/platform-corpus@1';
export const DRAFT_ROOT:'.build/linux-green/drafts';
export const DRAFT_ENV:'EDGEFFMPEG_CORPUS_DRAFT';
export const IMAGE_ENV:'EDGEFFMPEG_CONTAINER_IMAGE';
export const CORPORA_WORKFLOW:'Linux probe';
export const CORPORA_JOB:'corpora';
export function detectEmulation(input:{platform:string;arch:string;cpuinfo?:string;model?:string}):string|null;
export function executionEnvironment():ExecutionEnvironment;
export function ciRecord(env?:Readonly<Record<string,string|undefined>>):CiRecord|null;
export interface CommittedOrigin {
 readonly id:string;readonly tracked:string;readonly environment:Pick<ExecutionEnvironment,'emulated'|'cpuModel'>&{readonly emulation?:string|null}|null|undefined;
 readonly ci:Pick<CiRecord,'runId'|'workflow'|'job'|'provider'>|null|undefined;readonly image:string|null;readonly pinImage:string|null;
}
export function committedOriginRefusal(input:CommittedOrigin):string|null;
export function corpusWriteRefusal(input:CommittedOrigin&{readonly draft:boolean}):string|null;
export function corpusTarget(base:string,generator:string,options?:{draft?:boolean;root?:string}):CorpusTarget;
export function writePlatformCorpus(target:CorpusTarget,outputs:Readonly<Record<string,string|Uint8Array|unknown>>,options?:{root?:string}):{dir:string;files:string[]};
export function verifyPlatformCorpusDir(dir:string,id:string,options?:{root?:string;pins?:ReferencePins;allowDraft?:boolean}):PlatformCorpusProvenance;
