// SPDX-License-Identifier: LGPL-2.1-or-later
import type {FlacRangeAllocator} from './types.js';
export interface VorbisCommentEntry {readonly key:string;readonly value:string}
/** Structural hook: true means the chapter parser consumed the tag. */
export interface VorbisChapterHook {accept(key:string,value:string):boolean}
export type VorbisCommentDeferred = Readonly<{kind:'picture'|'chapter'|'channel-mask';key:string;value:string}> | Readonly<{kind:'invalid-utf8';sourceRange:Readonly<{offset:bigint;bytes:bigint}>}> | Readonly<{kind:'invalid-utf8';bytes:Uint8Array}>;
export interface VorbisCommentOptions {
 readonly maxEntries?:number;readonly maxDecodedBytes?:number;
 readonly initialEntries?:readonly VorbisCommentEntry[];
 readonly maxStateEntries?:number;readonly maxStateChars?:number;
 readonly chapterState?:VorbisChapterHook|null;
}
export interface VorbisCommentSnapshotOptions {parseError?:boolean;remainingBytes?:number;missingComments?:number}
export interface VorbisCommentResult {
 readonly tags:Readonly<Record<string,string>>;
 /** Ordered AVdict entries; unlike tags, preserves canonical-key collisions. */
 readonly entries:readonly VorbisCommentEntry[];readonly tagEntries:readonly VorbisCommentEntry[];
 readonly deferred:readonly VorbisCommentDeferred[];
 readonly parseError:boolean;readonly remainingBytes:number;readonly missingComments:number;
 readonly parsedEntries:number;readonly decodedBytes:number;
 readonly specialSemanticsComplete:boolean;readonly diagnosticsMapped:false;
}
export interface VorbisCommentCollector {accept(bytes:Uint8Array,location?:bigint|null):void;snapshot(options?:VorbisCommentSnapshotOptions):VorbisCommentResult;readonly parsedEntries:number}
export interface VorbisCommentReadOptions extends VorbisCommentOptions {
 readonly payloadOffset:bigint;readonly payloadBytes:number;readonly resources:FlacRangeAllocator;readonly signal:AbortSignal;
 readonly maxReadBytes?:number;readonly maxPayloadBytes?:number;readonly maxEntryBytes?:number;
 readonly checkpoint?:()=>void|Promise<void>;
}
