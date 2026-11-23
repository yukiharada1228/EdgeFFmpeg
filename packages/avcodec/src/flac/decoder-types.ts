/** Structural input and accounting capabilities; no dependency on Core. */
export interface FlacDecoderInput {
 readonly size: bigint;
 readAt(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface FlacDecoderOptions {
 readonly reserveExternalMemory: (bytes: number) => (() => void);
 readonly maxReadBytes?: number;
 readonly maxFrameBytes?: number;
 readonly signal?: AbortSignal;
 readonly checkpoint?: () => void | Promise<void>;
 readonly md5Checking?: boolean;
}
export interface FlacDecoderMetadata {
 readonly channels: number; readonly sampleRate: number; readonly bitsPerSample: number;
 readonly totalSamples: bigint; readonly maxBlockSamples: number;
}
/** Signed, right-justified libFLAC samples, borrowed until release or close.
 * Previously obtained typed-array references must not be used after release. */
export interface FlacDecodedFrame {
 readonly status: 'frame'; readonly metadata: FlacDecoderMetadata;
 readonly samples: number; readonly samplePosition: bigint;
 readonly planes: readonly Int32Array[];
 release(): void;
}
export type FlacDecoderResult = FlacDecodedFrame | {readonly status: 'metadata' | 'end'; readonly metadata: FlacDecoderMetadata};
export interface FlacDecoder {
 readonly metadata: FlacDecoderMetadata | null;
 readonly bytesRead: bigint;
 readonly memoryBytes: number;
 next(): Promise<FlacDecoderResult>;
 close(): Promise<void>;
}
