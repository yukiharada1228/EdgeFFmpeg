// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
import type { FlacRangeAllocator, FlacRangeSource } from './types.js';
export interface FlacMetadataOptions {
 readonly resources: FlacRangeAllocator;
 readonly signal: AbortSignal;
 readonly maxReadBytes?: number;
 readonly maxMetadataBlocks?: number;
 readonly maxMetadataBytes?: bigint;
 /** Trusted payload parser; capture source/resources/context in its closure.
  * Decline with null/undefined. Only pictures may consume beyond the advertised end.
  * The handler owns its I/O bounds and cleanup, including after cancellation.
  */
 readonly handleUnsupportedBlock?: (block: FlacMetadataBlock) => FlacMetadataHandling | null | undefined | PromiseLike<FlacMetadataHandling | null | undefined>;
 readonly checkpoint?: () => void | Promise<void>;
}
export interface FlacStreamInfo {
 readonly codec: 'flac';
 readonly minBlockSamples: number; readonly maxBlockSamples: number;
 readonly minFrameBytes: number; readonly maxFrameBytes: number;
 readonly sampleRate: number; readonly channels: number; readonly bitsPerSample: number;
 readonly totalSamples: bigint; readonly totalSamplesKnown: boolean; readonly md5: string;
 readonly timeBase: Readonly<{num: bigint; den: bigint}> | null;
}
export interface FlacMetadataBlock {
 readonly type: number; readonly last: boolean; readonly headerOffset: bigint;
 readonly payloadOffset: bigint; readonly length: number;
 readonly advertisedEndOffset: bigint;
 /** Null for an unhandled picture, whose parser may consume continuation bytes. */
 readonly effectiveEndOffset: bigint | null;
 readonly validation: 'streaminfo' | 'skipped' | 'unhandled' | 'validated';
}
export type FlacMetadataResult = Readonly<{
 kind: 'raw-frame-fallback'; framesOffset: 0n; sampleRateHint: number | null;
 metadataValidationComplete: false;
}> | Readonly<{
 kind: 'flac-streaminfo'; streamInfo: FlacStreamInfo | null;
 blocks: readonly FlacMetadataBlock[]; advertisedMetadataBytes: bigint;
 effectiveMetadataBytes: bigint | null; framesOffset: bigint | null;
 directoryComplete: boolean; metadataValidationComplete: boolean;
 continuation: Readonly<{kind: 'unhandled-picture'; blockIndex: number; advertisedNextOffset: bigint}> | null;
 unparsedMetadataTypes: readonly number[];
 malformedMetadataParityVerified: false;
}>;
export type FlacMetadataSource = FlacRangeSource;
export type FlacMetadataErrorCode = 'invalid-input' | 'resource-limit' | 'invalid-data' | 'input-read';

export interface FlacMetadataHandling {
 readonly effectiveEndOffset: bigint;
 readonly payloadValidated: boolean;
}
