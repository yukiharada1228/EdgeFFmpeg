import { parseArgv, CliError } from '@edge-ffmpeg/cli';
import type { ParsedCommand } from '@edge-ffmpeg/cli';
import { ResourceContext } from './resources.js';
import type { ResourceBudget, VirtualFileSystem } from './index.js';
export class ExecutionError extends Error {
  readonly exitCode: number;
  constructor(readonly code: string, message: string, options: { readonly exitCode?: number } = {}) {
    super(message);
    const exitCode = options.exitCode === undefined ? 1 : options.exitCode;
    if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) throw new RangeError('Execution failure exit code must be an integer from 1 through 255');
    this.exitCode = exitCode;
  }
}
/** Initial VFS input absence: Native AVERROR(ENOENT) maps to process254. */
export class InputNotFoundError extends ExecutionError {
 constructor(readonly path:string,cause?:unknown) {
  super('input-not-found','Input not found: '+path,{exitCode:254});
  if(cause!==undefined)this.cause=cause;
 }
}
/** Missing parent when opening a local virtual output,not a missing output file. */
export class OutputParentNotFoundError extends ExecutionError {
 constructor(readonly path:string,cause?:unknown) {
  super('output-parent-not-found','Output parent not found: '+path,{exitCode:254});
  if(cause!==undefined)this.cause=cause;
 }
}
/** Initial POSIX-style virtual file access denial,not post-open input change. */
export class PermissionDeniedError extends ExecutionError {
 constructor(readonly operation:'read'|'write',readonly path:string,cause?:unknown) {
  super('permission-denied',operation+' access denied: '+path,{exitCode:243});
  if(cause!==undefined)this.cause=cause;
 }
}
/** Initial path traversal through a non-directory component:fixed POSIX ENOTDIR. */
export class PathNotDirectoryError extends ExecutionError {
 constructor(readonly operation:'read'|'write',readonly path:string,cause?:unknown){
  super('path-not-directory','Path component is not a directory: '+path,{exitCode:236});
  if(cause!==undefined)this.cause=cause;
 }
}
/** A local output target is a directory:fixed POSIX EISDIR status235. */
export class OutputIsDirectoryError extends ExecutionError {
 constructor(readonly path:string,cause?:unknown){super('output-is-directory','Output is a directory: '+path,{exitCode:235});if(cause!==undefined)this.cause=cause;}
}
/** Failure while reading an accepted input, distinct from initial open failure. */
export class InputReadError extends ExecutionError {
 constructor(readonly path:string,message:string,options:{readonly exitCode:number;readonly cause?:unknown}){
  super('input-read-error',message,{exitCode:options.exitCode});
  if(options.cause!==undefined)this.cause=options.cause;
 }
}
/** Graceful command termination without publication (Native AVERROR_EXIT). */
export class ExecutionExit extends Error {
 constructor(readonly code: string, message: string) { super(message); }
}
export interface ExecutionDiagnostic { readonly code: string; readonly message: string }
export interface BackendContext {
 readonly filesystem: VirtualFileSystem; readonly signal: AbortSignal; readonly budget: Readonly<ResourceBudget>;
 /** Report nonfatal execution diagnostics. Optional for direct backend callers. */
 readonly reportDiagnostic?: (diagnostic: ExecutionDiagnostic) => void;
}
export interface ExecutionBackend {
  /** Validate the complete request before creating outputs. Never silently ignore options. */
  execute(command: ParsedCommand, context: BackendContext): Promise<readonly string[]>;
}
export interface FFmpegOptions { filesystem: VirtualFileSystem; backend?: ExecutionBackend; budget?: ResourceBudget }
export interface ExecResult { readonly error?: unknown; readonly exitCode: number; readonly outputs: readonly string[]; readonly diagnostics: readonly ExecutionDiagnostic[] }
/** Initial frontend. No backend is installed implicitly; exact FFmpeg logs are not yet reproduced. */
export class FFmpeg {
  readonly #filesystem: VirtualFileSystem;
  readonly #backend: ExecutionBackend | undefined;
  readonly #budget: Readonly<ResourceBudget>;
  constructor(options: FFmpegOptions) {
    this.#filesystem = options.filesystem; this.#backend = options.backend;
    const budget = options.budget ?? { maxResidentBytes: 64 * 1024 * 1024, maxBufferBytes: 64 * 1024, maxCpuTimeMs: 10000, maxPendingPackets: 8 };
    this.#budget = new ResourceContext(budget, new AbortController().signal).budget;
  }
  async exec(argv: readonly string[], options: { signal?: AbortSignal } = {}): Promise<ExecResult> {
    const signal = options.signal ?? new AbortController().signal;
    const diagnostics: ExecutionDiagnostic[] = [];
    let diagnosticBytes = 0, settled = false, truncated = false;
    const reportDiagnostic = (diagnostic: ExecutionDiagnostic): void => {
      if (settled) return;
      const { code, message } = diagnostic;
      if (typeof code !== 'string' || typeof message !== 'string') throw new TypeError('Invalid execution diagnostic');
      // Bound retained text and entry overhead; this is not a runtime heap measurement.
      const bytes = 128 + 2 * (code.length + message.length);
      if (truncated || bytes > this.#budget.maxBufferBytes - diagnosticBytes) {
        if (!truncated) diagnostics.push(Object.freeze({ code: 'diagnostics-truncated', message: 'Execution diagnostic retention limit reached' }));
        truncated = true;
        return;
      }
      diagnosticBytes += bytes;
      diagnostics.push(Object.freeze({ code, message }));
    };
    try {
      signal.throwIfAborted();
      const command = parseArgv(argv);
      if (!this.#backend) throw new ExecutionError('unimplemented', 'No execution backend is installed');
      const outputs = await this.#backend.execute(command, { filesystem: this.#filesystem, signal, budget: this.#budget, reportDiagnostic });
      settled = true;
      return Object.freeze({ exitCode: 0, outputs: Object.freeze([...outputs]), diagnostics: Object.freeze(diagnostics) });
    } catch (error) {
      settled = true;
      if (!signal.aborted && error instanceof ExecutionExit) return Object.freeze({ exitCode: 0, outputs: Object.freeze([]), diagnostics: Object.freeze([...diagnostics, Object.freeze({ code: error.code, message: error.message })]) });
      const code = signal.aborted ? 'cancelled' : error instanceof ExecutionError ? error.code : error instanceof CliError ? 'invalid-arguments' : 'execution-failed';
      const message = error instanceof Error ? error.message : String(error);
      const published = error instanceof ExecutionError && 'publishedOutputs' in error && Array.isArray(error.publishedOutputs) && error.publishedOutputs.every(value => typeof value === 'string') ? error.publishedOutputs as string[] : [];
      return Object.freeze({ exitCode: signal.aborted ? 1 : error instanceof ExecutionError ? error.exitCode : 1, error, outputs: Object.freeze([...published]), diagnostics: Object.freeze([...diagnostics, Object.freeze({ code, message })]) });
    }
  }
}
