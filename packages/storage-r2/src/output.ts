import type { R2Bucket, R2UploadedPart } from '@cloudflare/workers-types';
import type { WriteHandle } from '@edge-ffmpeg/core';
export interface R2OutputOptions {
  readonly writableMounts: readonly string[];
  readonly stagingPrefix: string;
  readonly partBytes: number;
  readonly maxWriteBytes: number;
  readonly maxOutputBytes: number;
}
export class R2CommitUncertainError extends Error {
  constructor(readonly key: string, readonly stagingKey: string, readonly transactionId: string, cause: unknown) { super('R2 publication outcome is uncertain; staging retained for reconciliation', { cause }); }
}
export class R2OutputCleanupError extends Error {
  readonly published = true;
  constructor(readonly key: string, readonly stagingKey: string, readonly transactionId: string, cause: unknown) { super('R2 output published but staging cleanup failed', { cause }); }
}
/** Only positively confirms publication by transaction marker; a nonmatch remains unresolved. */
export async function recoverPublishedR2Output(bucket: R2Bucket, transaction: { key: string; stagingKey: string; transactionId: string }): Promise<boolean> {
  const current = await bucket.head(transaction.key);
  if (current?.customMetadata?.edgeffmpegTransaction !== transaction.transactionId) return false;
  // Delete only a staging object carrying the same marker.
  const staged = await bucket.head(transaction.stagingKey);
  if (staged && staged.customMetadata?.edgeffmpegTransaction !== transaction.transactionId) throw new Error('Staging transaction marker mismatch');
  if (staged) await bucket.delete(transaction.stagingKey);
  return true;
}
export async function createR2Output(bucket: R2Bucket, key: string, overwrite: boolean, options: R2OutputOptions): Promise<WriteHandle> {
  const transactionId = crypto.randomUUID(), stagingKey = `${options.stagingPrefix}/${transactionId}`;
  const marker = { edgeffmpegTransaction: transactionId };
  const capacity = Math.min(options.partBytes, options.maxOutputBytes);
  const upload = await bucket.createMultipartUpload(stagingKey, { customMetadata: marker });
  const parts: R2UploadedPart[] = [];
  let buffer: Uint8Array | undefined, buffered = 0, total = 0;
  let state: 'open' | 'failed' | 'published' | 'uncertain' | 'aborted' = 'open';
  let busy = false, completed = false, cleaned = false;
  function begin(): void {
    if (busy) throw new Error('Concurrent R2 output operations are unsupported');
    if (state !== 'open') throw new Error(`R2 output is ${state}`);
    busy = true;
  }
  async function flush(): Promise<void> {
    if (!buffered) return;
    if (parts.length >= 10000) throw new RangeError('R2 multipart part count exceeded');
    parts.push(await upload.uploadPart(parts.length + 1, buffer!.subarray(0, buffered)));
    buffered = 0;
  }
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    try { await bucket.delete(stagingKey); cleaned = true; }
    catch (error) { throw new R2OutputCleanupError(key, stagingKey, transactionId, error); }
  }
  return {
    async write(chunk) {
      begin();
      try {
        if (chunk.byteLength > options.maxWriteBytes || total + chunk.byteLength > options.maxOutputBytes) throw new RangeError('R2 output byte budget exceeded');
        // Small final parts need not reserve a complete multipart-sized buffer.
        // Promote once when needed; upload boundaries still use partBytes.
        if (chunk.length && !buffer) buffer = new Uint8Array(chunk.length > 4096 ? capacity : Math.min(4096, capacity));
        let offset = 0;
        while (offset < chunk.length) {
          const count = Math.min(chunk.length - offset, options.partBytes - buffered);
          if (buffered + count > buffer!.length) {
            const grown = new Uint8Array(capacity);
            grown.set(buffer!.subarray(0, buffered));
            buffer = grown;
          }
          buffer!.set(chunk.subarray(offset, offset + count), buffered); buffered += count; offset += count;
          if (buffered === options.partBytes) await flush();
        }
        total += chunk.length;
      } catch (error) { state = 'failed'; throw error; }
      finally { busy = false; }
    },
    async commit() {
      if (busy) throw new Error('Concurrent R2 output operations are unsupported');
      if (state === 'published') { busy = true; try { await cleanup(); } finally { busy = false; } return; }
      begin();
      try {
        await flush(); buffer = undefined;
        if (!parts.length) {
          await upload.abort();
          completed = true;
          await bucket.put(stagingKey, new Uint8Array(), { customMetadata: marker });
        } else await upload.complete(parts);
        completed = true;
        const staged = await bucket.get(stagingKey);
        if (!staged || staged.customMetadata?.edgeffmpegTransaction !== transactionId || staged.size !== total) {
          if (staged) await staged.body.cancel();
          throw new Error('R2 staging integrity check failed');
        }
        let published;
        try {
          published = overwrite
            ? await bucket.put(key, staged.body, { customMetadata: marker })
            : await bucket.put(key, staged.body, { customMetadata: marker, onlyIf: { etagDoesNotMatch: '*' } });
        } catch (error) {
          state = 'uncertain';
          throw new R2CommitUncertainError(key, stagingKey, transactionId, error);
        } finally {
          if (!staged.bodyUsed) await staged.body.cancel();
        }
        if (!published) throw new Error('R2 output already exists');
        state = 'published';
        await cleanup();
      } catch (error) { if (state !== 'published' && state !== 'uncertain') state = 'failed'; throw error; }
      finally { busy = false; }
    },
    async abort() {
      if (busy) throw new Error('Concurrent R2 output operations are unsupported');
      if (state === 'published' || state === 'uncertain' || state === 'aborted') return;
      busy = true; buffer = undefined;
      try {
        if (completed) await bucket.delete(stagingKey);
        else {
          let failure: { error: unknown } | undefined;
          try { await upload.abort(); } catch (error) { failure = { error }; }
          // Completion may have succeeded even if its acknowledgement was lost.
          const staged = await bucket.head(stagingKey);
          if (staged) {
            if (staged.customMetadata?.edgeffmpegTransaction !== transactionId) throw new Error('Staging transaction marker mismatch');
            await bucket.delete(stagingKey);
          } else if (failure) throw failure.error;
        }
        state = 'aborted';
      } finally { busy = false; }
    }
  };
}
