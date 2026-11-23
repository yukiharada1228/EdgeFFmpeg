export type { Rational, Timestamp, MediaPacket, VideoFrameData, AudioFrameData } from "@edge-ffmpeg/avutil";
export interface ReadHandle {
  readonly size: bigint;
  /** Optional non-consuming check for deferred input read failure. */
  probeRead?(signal?: AbortSignal): Promise<void>;
  readAt(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface WriteOptions {
  /** Adapters must honor an explicit overwrite policy or reject it. */
  readonly overwrite?: boolean;
}
export interface VirtualFileSystem {
  /** Non-mutating writable-path validation,also used with overwrite;atomic publication remains required. */
  outputExists?(path: string, signal?: AbortSignal, options?: WriteOptions): Promise<boolean>;
  openRead(path: string): Promise<ReadHandle>;
  openWrite(path: string, options?: WriteOptions): Promise<WriteHandle>;
}
export interface ResourceBudget {
  maxResidentBytes: number; maxBufferBytes: number; maxCpuTimeMs: number; maxPendingPackets: number;
}
export type CapabilityStatus = "unimplemented" | "partial" | "conformant" | "bitexact" | "runtime-blocked";
export { ResourceContext } from './resources.js';
export type { OwnedBuffer, ExternalMemoryRelease } from './resources.js';
export { PacketQueue } from './packet-queue.js';
export type { PacketReservation } from './packet-queue.js';
export { FeatureRegistry, FeatureResolutionError } from './registry.js';
export type { FeatureDescriptor } from './registry.js';
export { planGraph, PlanningError } from './planner.js';
export type { OperatorDescriptor, OperatorPort, MediaPortType, GraphNode, GraphEdge, ExecutionGraph, PlannedGraph } from './planner.js';
export { FFmpeg, ExecutionError, InputReadError, ExecutionExit, InputNotFoundError, OutputParentNotFoundError, PermissionDeniedError, PathNotDirectoryError, OutputIsDirectoryError } from './ffmpeg.js';
export type { FFmpegOptions, ExecutionBackend, BackendContext, ExecResult, ExecutionDiagnostic } from './ffmpeg.js';
export {planIndependentGraph} from './distributed-planner.js';
export type {IndependentGraphPlan,IndependentGraphWorkUnit} from './distributed-planner.js';
export {lowerIndependentCommand} from './command-graph.js';
export type {CommandOperatorBinding,CommandGraphLowering} from './command-graph.js';
export {lowerComplexVideoCommand} from './complex-command-graph.js';
export {CheckpointCompatibilityError,validateExecutionCheckpoint,serializeExecutionCheckpoint,deserializeExecutionCheckpoint} from './checkpoint.js';
export type {ExecutionCheckpoint,ExecutionCheckpointIdentity} from './checkpoint.js';
