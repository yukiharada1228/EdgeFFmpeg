export interface ReferenceArtifacts {readonly ffmpeg:string;readonly ffprobe:string}
export interface BuildMetadata {
 readonly artifacts:ReferenceArtifacts;readonly commit:string;readonly platform:string;readonly arch:string;
 readonly flags:readonly string[];readonly compiler:string;readonly version:string;readonly [key:string]:unknown;
}
export interface ReferencePinRecord {
 readonly platform:string;readonly arch:string;readonly artifacts:ReferenceArtifacts;readonly libraries:Readonly<Record<string,string>>;
 readonly librariesSource?:string;readonly compiler:string;readonly image?:string;readonly source:string;
}
export interface ReferencePin extends ReferencePinRecord {readonly id:string}
export interface ReferencePins {
 readonly schemaVersion:1;readonly comment?:string;readonly commit:string;readonly tag:string;readonly flags:readonly string[];
 readonly platforms:Readonly<Record<string,ReferencePinRecord>>;
}
export interface UpstreamLock {readonly commit:string;readonly tag:string;readonly configureFile:string;readonly [key:string]:unknown}
export interface ReferenceInputs {
 readonly metadata:BuildMetadata;readonly upstream:UpstreamLock;readonly flags:readonly string[];
 readonly host:{readonly platform:string;readonly arch:string};readonly hashes:ReferenceArtifacts;readonly pins:ReferencePins;
}
export interface ReferenceIdentity {
 readonly id:string;readonly platform:string;readonly arch:string;readonly ffmpeg:string;readonly ffprobe:string;
 readonly libraries:Readonly<Record<string,string>>;readonly metadata:BuildMetadata;readonly pin:ReferencePin;
}
/** Build-metadata shape stored in provenance records. */
export interface RecordedReference {readonly platform:string;readonly arch:string;readonly artifacts:{readonly ffmpeg:string;readonly ffprobe?:string}}
/** Provenance written by tools/differential-runner/platform-corpus.mjs. */
export interface RecordedCorpusProvenance {readonly referenceId?:string;readonly reference:RecordedReference}
export const PINS_FILE:'compat/reference-pins.json';
export const PROGRAMS:readonly ['ffmpeg','ffprobe'];
export const LEGACY_CORPUS_PLATFORM:'darwin-arm64';
export function sha256(bytes:Uint8Array|string):string;
export function sha256File(path:string):string;
export function platformId(platform:string,arch:string):string;
export function loadReferencePins(root?:string):ReferencePins;
export function referencePinFrom(pins:ReferencePins,id:string):ReferencePin;
export function resolveReferenceIdentity(inputs:ReferenceInputs):ReferenceIdentity;
export function configureFlags(root?:string,upstream?:UpstreamLock):string[];
export function readReferenceInputs(root?:string,options?:{dir?:string;host?:{platform:string;arch:string}}):ReferenceInputs;
export function localReferenceIdentity(root?:string,options?:{dir?:string;host?:{platform:string;arch:string}}):ReferenceIdentity;
export function assertRecordedPin(recorded:RecordedReference|RecordedCorpusProvenance,id:string,pins:ReferencePins):ReferencePin;
export function platformCorpusDirFor(base:string,id:string,pins:ReferencePins):string;
