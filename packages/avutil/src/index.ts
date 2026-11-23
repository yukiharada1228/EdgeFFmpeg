import type {Rational,Timestamp} from './rational.js';
export {rational,rescale} from './rational.js';
export type {Rational,Timestamp} from './rational.js';
export interface MediaPacket {
  streamIndex: number; data: Uint8Array; pts: bigint | null; dts: bigint | null;
  duration: bigint | null; timeBase: Rational; flags: number;
}
export interface VideoFrameData {
  width: number; height: number; pixelFormat: string; planes: Uint8Array[];
  linesizes: number[]; pts: Timestamp | null; metadata: Record<string, unknown>;
}
export interface AudioFrameData {
  sampleRate: number; channels: number; channelLayout: string; sampleFormat: string;
  samples: number; planes: Uint8Array[]; pts: Timestamp | null;
}
export type PcmCodec = 'pcm_u8' | 'pcm_s16le' | 'pcm_s24le' | 'pcm_s32le' | 'pcm_f32le' | 'pcm_f64le' | 'pcm_alaw' | 'pcm_mulaw' | 'pcm_s8' | 'pcm_s16be' | 'pcm_s24be' | 'pcm_s32be' | 'pcm_f32be' | 'pcm_f64be' | 'pcm_u16le' | 'pcm_u16be' | 'pcm_u24le' | 'pcm_u24be' | 'pcm_u32le' | 'pcm_u32be';

export {parseTimeDuration,TimeSyntaxError} from './duration.js';

/** Finite semantic packet boundaries; cumulative queries must be deterministic. */
export interface AudioPacketSchedule {
  readonly sampleCount:bigint;
  readonly packetCount:bigint;
  samplesForPackets(packets:bigint):bigint;
}
export {pixelLayout,PixelLayoutError} from './pixel-layout.js';
export type {VideoPixelFormat,PixelPlaneLayout,PixelLayout} from './pixel-layout.js';
export {videoFrameRate,parseVideoFrameRate,VideoRateError} from './video-rate.js';

export {parseVideoSize,VideoSizeError} from './video-size.js';

export {compileExpression,evaluateExpression} from './expression/index.js';
export type {CompiledExpression,ExpressionNumericProfile,ExpressionOptions,ExpressionPrint} from './expression/index.js';

export {createThreadFrameQueue} from './thread-frame-queue.js';
export type {ThreadFrameLease,ThreadFrameQueueOptions,ThreadFrameQueueResult} from './thread-frame-queue.js';
export {reduceBoundedRational} from './bounded-rational.js';
export type {ReducedRational} from './bounded-rational.js';
export {numberToBoundedRational} from './number-rational.js';

export {snapshotFrameMetadata} from './frame-metadata.js';
export {formatPrint} from './expression/format-print.js';

export {scaleSampleAspectRatio} from './video-aspect.js';

export {videoStoragePixelFormat} from './video-storage-format.js';

export {defaultChannelLayout} from './channel-layout.js';
export type {DefaultChannelLayout} from './channel-layout.js';
