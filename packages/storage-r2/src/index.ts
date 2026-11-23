import {InputNotFoundError} from '@edge-ffmpeg/core';
import { createR2Output } from './output.js';
import type { R2OutputOptions } from './output.js';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { ReadHandle, VirtualFileSystem } from '@edge-ffmpeg/core';
export class InputChangedError extends Error {}
export interface R2FileSystemOptions {
  bucket: R2Bucket;
  mounts: Record<string, string>;
  maxReadBytes: number;
  output?: R2OutputOptions;
}
function segments(path: string): string[] {
  if (!path.startsWith('/') || /[\\\0]/.test(path)) throw new Error('Invalid absolute path');
  const parts = path.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Path traversal');
  return parts;
}
/** R2 range reads and opt-in staged sequential output. */
export function createR2FileSystem(options: R2FileSystemOptions): VirtualFileSystem {
  const { bucket, maxReadBytes } = options;
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new RangeError('Invalid read limit');
  const mounts = Object.entries(options.mounts).map(([mount, prefix]) => {
    const normalized = '/' + segments(mount).join('/');
    if (prefix.startsWith('/') || prefix.split('/').some(p => p === '..' || p === '.') || /[\\\0]/.test(prefix)) throw new Error('Invalid object prefix');
    return { mount: normalized, prefix: prefix.replace(/\/+$/, '') };
  }).sort((a, b) => b.mount.length - a.mount.length);
  if (new Set(mounts.map(mount => mount.mount)).size !== mounts.length) throw new Error('Duplicate normalized R2 mounts');
  const output = options.output ? Object.freeze({ ...options.output, writableMounts: Object.freeze([...options.output.writableMounts]), stagingPrefix: options.output.stagingPrefix.replace(/\/+$/, '') }) : undefined;
  const writableMounts = new Set(output?.writableMounts.map(mount => '/' + segments(mount).join('/')) ?? []);
  if (output) {
    if (!writableMounts.size || [...writableMounts].some(mount => !mounts.some(entry => entry.mount === mount))) throw new Error('Writable R2 mounts must be explicitly configured');
    const { partBytes, maxWriteBytes, maxOutputBytes, stagingPrefix } = output;
    if (!stagingPrefix || stagingPrefix.startsWith('/') || /[\\\0]/.test(stagingPrefix) || stagingPrefix.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid R2 staging prefix');
    if (!Number.isSafeInteger(partBytes) || partBytes < 5 * 1024 * 1024 || partBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(maxWriteBytes) || maxWriteBytes <= 0 || maxWriteBytes > partBytes || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > partBytes * 10000) throw new RangeError('Invalid R2 output limits');
    if (mounts.some(mount => !mount.prefix || stagingPrefix === mount.prefix || stagingPrefix.startsWith(mount.prefix + '/') || mount.prefix.startsWith(stagingPrefix + '/'))) throw new Error('R2 staging prefix must not be reachable through a VFS mount');
  }
  function keyFor(path: string, writing = false): string {
    const normalized = '/' + segments(path).join('/');
    const match = mounts.find(m => m.mount === '/' || normalized.startsWith(m.mount + '/'));
    if (!match) throw new Error('Path is not mounted');
    if (writing && !writableMounts.has(match.mount)) throw new Error('R2 mount is read-only');
    const suffix = normalized.slice(match.mount === '/' ? 1 : match.mount.length + 1);
    if (!suffix) throw new Error('File path required');
    return [match.prefix, suffix].filter(Boolean).join('/');
  }
  return {
    async outputExists(path, signal) {
      signal?.throwIfAborted();
      if (!output) throw new Error('R2 output is not enabled');
      const key = keyFor(path, true), object = await bucket.head(key);
      signal?.throwIfAborted();
      return object !== null;
    },
    async openRead(path): Promise<ReadHandle> {
      const key = keyFor(path);
      const initial = await bucket.head(key);
      if (!initial) throw new InputNotFoundError(path);
      if (!Number.isSafeInteger(initial.size) || initial.size < 0) throw new RangeError('Unsafe object size');
      const size = BigInt(initial.size);
      return {
        size,
        async readAt(offset, length, signal) {
          signal?.throwIfAborted();
          if (offset < 0n || !Number.isSafeInteger(length) || length < 0 || length > maxReadBytes) throw new RangeError('Invalid read range');
          if (offset >= size || length === 0) return new Uint8Array();
          const count = Number(size - offset < BigInt(length) ? size - offset : BigInt(length));
          const object = await bucket.get(key, { range: { offset: Number(offset), length: count }, onlyIf: { etagMatches: initial.etag } });
          if (!object || !('body' in object)) throw new InputChangedError('Input changed while reading');
          if (object.version !== initial.version) {
            await object.body.cancel();
            throw new InputChangedError('Input generation changed while reading');
          }
          if (signal?.aborted) { await object.body.cancel(); signal.throwIfAborted(); }
          const data = new Uint8Array(await object.arrayBuffer());
          signal?.throwIfAborted();
          if (data.byteLength !== count) throw new Error('Unexpected ranged read length');
          return data;
        }
      };
    },
    async openWrite(path, writeOptions) {
      if (!output) throw new Error('R2 output is not enabled');
      return createR2Output(bucket, keyFor(path, true), writeOptions?.overwrite === true, output);
    }
  };
}

export { R2CommitUncertainError, R2OutputCleanupError, recoverPublishedR2Output } from './output.js';
export type { R2OutputOptions } from './output.js';

export {createR2SpoolStore} from './spool.js';
export type {R2SpoolStore} from './spool.js';
