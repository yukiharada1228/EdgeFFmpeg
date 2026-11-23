import {constants} from 'node:fs';
import {InputNotFoundError,OutputParentNotFoundError,PermissionDeniedError,ExecutionError,InputReadError,PathNotDirectoryError,OutputIsDirectoryError} from '@edge-ffmpeg/core';
import { open, realpath, stat, link, rename, unlink, access } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { VirtualFileSystem, WriteHandle, ReadHandle } from '@edge-ffmpeg/core';
export class NodeInputChangedError extends Error {}
export class NodeAtomicOutputUnavailableError extends ExecutionError {
 constructor(readonly outputPath:string,cause:unknown){super('runtime-blocked','Atomic replacement requires a writable output parent: '+outputPath);this.cause=cause;}
}
export class NodeOutputCommitError extends Error {
  readonly published = true;
  constructor(readonly outputPath: string, readonly stagingPath: string, cause: unknown) { super('Output published but staging cleanup failed', { cause }); }
}
export interface NodeFileSystemOptions {
  readonly root: string;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly overwrite?: boolean;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Local development adapter for a trusted directory tree. Reads reopen/close per range. */
export async function createNodeFileSystem(options: NodeFileSystemOptions): Promise<VirtualFileSystem> {
  const { maxReadBytes, maxWriteBytes } = options;
  const defaultOverwrite = options.overwrite === true;
  for (const limit of [maxReadBytes, maxWriteBytes]) if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid Node I/O limit');
  const root = await realpath(options.root);
  if (!(await stat(root)).isDirectory()) throw new Error('Filesystem root must be a directory');
  function contained(path: string): string {
    const difference = relative(root, path);
    if (difference === '..' || difference.startsWith('..' + sep) || isAbsolute(difference)) throw new Error('Path escapes filesystem root');
    return path;
  }
  function localPath(path: string): string {
    if (!path.startsWith('/') || /[\\\0]/.test(path)) throw new Error('Invalid virtual path');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) throw new Error('Invalid file path');
    const local=contained(resolve(root,...parts));return path.endsWith('/')?local+sep:local;
  }
  async function outputParent(target:string,path:string):Promise<string>{
    try{return contained(await realpath(dirname(target)));}
    catch(error){if(error instanceof Error&&'code'in error){if(error.code==='ENOENT')throw new OutputParentNotFoundError(path,error);if(error.code==='EACCES')throw new PermissionDeniedError('write',path,error);if(error.code==='ENOTDIR')throw new PathNotDirectoryError('write',path,error);}throw error;}
  }
  async function targetExists(output:string,path:string):Promise<boolean>{
    try{contained(await realpath(path.endsWith('/')?output.slice(0,-sep.length):output));if(path.endsWith('/'))await stat(output);return true;}
    catch(error){if(error instanceof Error&&'code'in error){if(error.code==='ENOENT'){if(path.endsWith('/'))throw new OutputParentNotFoundError(path,error);return false;}if(error.code==='EACCES')throw new PermissionDeniedError('write',path,error);if(error.code==='ENOTDIR')throw new PathNotDirectoryError('write',path,error);}throw error;}
  }
  async function requireOutputAccess(output:string,parent:string,path:string,exists:boolean,overwrite:boolean,staging=false):Promise<void>{
    if(exists&&!overwrite&&!staging)return;
    if(exists&&(overwrite||staging)&&(await stat(output)).isDirectory())throw new OutputIsDirectoryError(path);
    if(exists&&overwrite)try{await access(output,constants.W_OK);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='EACCES')throw new PermissionDeniedError('write',path,error);throw error;}
    if(exists&&overwrite&&!staging)return;
    try{await access(parent,constants.W_OK|constants.X_OK);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='EACCES'){if(exists&&overwrite)throw new NodeAtomicOutputUnavailableError(path,error);throw new PermissionDeniedError('write',path,error);}throw error;}
  }
  return {
    async outputExists(path, signal, writeOptions) {
      const overwrite=writeOptions?.overwrite===true;
      signal?.throwIfAborted();
      const target=localPath(path),parent=await outputParent(target,path),output=resolve(parent,basename(target))+(path.endsWith('/')?sep:''),exists=await targetExists(output,path);
      await requireOutputAccess(output,parent,path,exists,overwrite);
      signal?.throwIfAborted();
      return exists;
    },
    async openRead(path) {
      const target=localPath(path);
      let canonical:string,initial:BigIntStats;
      try { canonical=contained(await realpath(path.endsWith('/')?target.slice(0,-sep.length):target));if(path.endsWith('/'))await stat(target);const opened=await open(canonical,'r');try{initial=await opened.stat({bigint:true});}finally{await opened.close();} }
      catch(error) { if(error instanceof Error&&'code'in error){if(error.code==='ENOENT')throw new InputNotFoundError(path,error);if(error.code==='EACCES')throw new PermissionDeniedError('read',path,error);if(error.code==='ENOTDIR')throw new PathNotDirectoryError('read',path,error);}throw error; }
      if (!initial.isFile() && !initial.isDirectory()) throw new Error('Input must be a regular file or directory');
      const directory = initial.isDirectory();
      const handle:ReadHandle = {
        size: initial.size,
        async readAt(offset, length, signal) {
          signal?.throwIfAborted();
          if (offset < 0n || !Number.isSafeInteger(length) || length < 0 || length > maxReadBytes) throw new RangeError('Invalid Node read range');
          if (!length || (!directory && offset >= initial.size)) return new Uint8Array();
          let file:Awaited<ReturnType<typeof open>>;
          try { file=await open(canonical,'r'); }
          catch(error) { if(error instanceof Error&&'code'in error&&error.code==='ENOENT')throw new NodeInputChangedError('Input disappeared while reading',{cause:error});if(error instanceof Error&&'code'in error&&error.code==='EACCES')throw new NodeInputChangedError('Input access changed while reading',{cause:error});if(error instanceof Error&&'code'in error&&error.code==='ENOTDIR')throw new NodeInputChangedError('Input path changed while reading',{cause:error});throw error; }
          try {
            if (!sameFile(initial, await file.stat({ bigint: true }))) throw new NodeInputChangedError('Input changed while reading');
            const count = directory ? length : Number(initial.size - offset < BigInt(length) ? initial.size - offset : BigInt(length));
            const bytes = new Uint8Array(count);
            let filled = 0;
            while (filled < count) {
              signal?.throwIfAborted();
              const result = await file.read(bytes, filled, count - filled, offset + BigInt(filled));
              if (!result.bytesRead) break;
              filled += result.bytesRead;
            }
            signal?.throwIfAborted();
            if (!sameFile(initial, await file.stat({ bigint: true }))) throw new NodeInputChangedError('Input changed during read');
            if (filled !== count) throw new Error('Unexpected input EOF');
            return bytes;
          } catch(error) {
            if(error instanceof Error && 'code' in error && error.code === 'EISDIR') throw new InputReadError(path,'Is a directory',{exitCode:235,cause:error});
            throw error;
          } finally { await file.close(); }
        }
      };
      return directory ? {...handle,async probeRead(signal?:AbortSignal){await handle.readAt(0n,1,signal);}} : handle;
    },
    async openWrite(path, writeOptions): Promise<WriteHandle> {
      const overwrite = writeOptions?.overwrite ?? defaultOverwrite;
      const target = localPath(path);
      const parent = await outputParent(target,path);
      const output = resolve(parent, basename(target))+(path.endsWith('/')?sep:'');
      await requireOutputAccess(output,parent,path,await targetExists(output,path),overwrite,true);
      const staging = resolve(parent, `.${basename(target)}.${randomUUID()}.edgeffmpeg.tmp`);
      let file:Awaited<ReturnType<typeof open>>;
      try{file=await open(staging,'wx',0o600);}catch(error){if(error instanceof Error&&'code'in error){if(error.code==='ENOENT')throw new OutputParentNotFoundError(path,error);if(error.code==='ENOTDIR')throw new PathNotDirectoryError('write',path,error);if(error.code==='EACCES')throw new PermissionDeniedError('write',path,error);}throw error;}
      let state: 'open' | 'failed' | 'committing' | 'committed' | 'aborted' = 'open';
      let busy = false, closed = false;
      function begin(): void {
        if (busy) throw new Error('Concurrent output operations are unsupported');
        if (state !== 'open') throw new Error(`Output is ${state}`);
        busy = true;
      }
      async function close(): Promise<void> { if (!closed) { await file.close(); closed = true; } }
      return {
        async write(chunk) {
          begin();
          try {
            if (chunk.byteLength > maxWriteBytes) throw new RangeError('Node write exceeds budget');
            let offset = 0;
            while (offset < chunk.length) {
              const result = await file.write(chunk, offset, chunk.length - offset, null);
              if (!result.bytesWritten) throw new Error('Output write made no progress');
              offset += result.bytesWritten;
            }
          } catch (error) { state = 'failed'; throw error; }
          finally { busy = false; }
        },
        async commit() {
          if (state === 'committed') return;
          begin(); state = 'committing';
          try {
            await file.sync(); await close();
            if (overwrite) await rename(staging, output);
            else await link(staging, output); // Atomic no-clobber publication in the same directory.
            state = 'committed';
            if (!overwrite) {
              try { await unlink(staging); }
              catch (error) { throw new NodeOutputCommitError(output, staging, error); }
            }
          } catch (error) { if (state !== 'committed') state = 'failed'; throw error; }
          finally { busy = false; }
        },
        async abort() {
          if (state === 'committed' || state === 'aborted') return;
          if (busy) throw new Error('Concurrent output operations are unsupported');
          busy = true;
          const errors: unknown[] = [];
          try {
            try { await close(); } catch (error) { errors.push(error); }
            try { await unlink(staging); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) errors.push(error); }
            state = errors.length ? 'failed' : 'aborted';
            if (errors.length) throw new AggregateError(errors, 'Output cleanup failed');
          } finally { busy = false; }
        }
      };
    }
  };
}
