// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
import type{ReadHandle,OwnedBuffer}from'@edge-ffmpeg/core';
import type{FlacPacketRange,FlacParserMetrics}from'@edge-ffmpeg/avcodec';
export interface FlacRangeSource extends ReadHandle {
 /** Synchronous only: must not retain destination or write to it after returning (including on error). */
 readInto?(offset:bigint,destination:Uint8Array,signal?:AbortSignal):number;
}
export interface FlacRangeAllocator{allocate(bytes:number):OwnedBuffer}
export interface FlacDiscoveryOptions {readonly resources:FlacRangeAllocator;readonly signal:AbortSignal;readonly maxScanBytes:bigint;readonly startOffset?:bigint;readonly maxReadBytes?:number;readonly maxCandidates?:number}
export interface FlacDiscoveryMetrics {readonly readCalls:number;readonly bytesRead:bigint;readonly candidates:number;readonly maximumRead:number;readonly ownedBufferBytes:number;readonly peakOwnedBufferBytes:number;readonly closed:boolean;readonly padded:boolean;readonly providerBuffersIncluded:false}
export interface FlacRangeStreamOptions extends FlacDiscoveryOptions {readonly parserChunkBytes?:number;readonly maxParserCalls?:number;readonly maxHeaders?:number;readonly maxCrcQueries?:number;readonly maxLogicalFifoBytes?:number;readonly checkpoint?:()=>Promise<void>}
export interface FlacIntakeRange extends FlacPacketRange {readonly parserFrameOffset:bigint;readonly parserRawIndex:number}
export interface FlacRangeStream extends AsyncIterable<FlacIntakeRange> {close(reason?:unknown):void;readonly metrics:{readonly calls:number;readonly packets:number;readonly closed:boolean;readonly parser:FlacParserMetrics|null;readonly discovery:FlacDiscoveryMetrics|null;readonly avioPartialSchedulingImplemented:false}}
export interface FlacPacketChunk {readonly offset:bigint;readonly data:Uint8Array;release():void}
export interface FlacPacketChunkOptions {readonly resources:FlacRangeAllocator;readonly signal:AbortSignal;readonly maxReadBytes?:number;readonly maxPacketBytes:bigint;readonly checkpoint?:()=>Promise<void>}
export interface FlacPacketChunkReader extends AsyncIterable<FlacPacketChunk>{readonly metrics:{readonly readCalls:number;readonly bytesRead:bigint;readonly ownedBufferBytes:number;readonly peakOwnedBufferBytes:number;readonly completed:boolean;readonly closed:boolean;readonly providerBufferAccounted:false}}
