// SPDX-License-Identifier: LGPL-2.1-or-later; derived from pinned libavformat/flac_picture.c.
import type {FlacRangeAllocator} from './types.js';
export interface FlacPictureOptions {
 readonly transport?:'block'|'comment'; readonly explode?:boolean; readonly strictCompliance?:number;
 readonly maxPayloadBytes?:number; readonly maxPictureBytes?:number; readonly maxDescriptionBytes?:number;
}
export interface FlacPictureField {readonly offset:number;readonly length:number}
export type FlacPictureDescriptor =
 | Readonly<{kind:'ignored';fatal:boolean;reason:string;warnings:readonly string[]}>
 | Readonly<{kind:'deferred';fatal:false;reason:'invalid-description-utf8';descriptionOffset:number;descriptionBytes:number}>
 | Readonly<{kind:'needs-truncation-read';fatal:false;dataOffset:number;dataBytes:number;additionalBytes:number}>
 | Readonly<{kind:'accepted';fatal:false;codec:string;mime:string;type:number;declaredWidth:number;declaredHeight:number;dataOffset:number;dataBytes:number;tags:Readonly<{comment:string;title?:string}>;warnings:readonly string[]}>;
export interface FlacPictureReadOptions extends FlacPictureOptions {
 readonly payloadOffset:bigint;readonly payloadBytes:number;readonly resources:FlacRangeAllocator;
 readonly signal:AbortSignal;readonly maxReadBytes?:number;readonly checkpoint?:()=>void|Promise<void>;
}
