/* SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
 * STREAMINFO and ordering derived from FFmpeg libavformat/flacdec.c,
 * Copyright (c) 2001 Fabrice Bellard. Distributed under LGPL 2.1 or later,
 * WITHOUT ANY WARRANTY; see the repository license notices.
 */
import { waitForFlacAbort } from './abort-wait.js';
import type { FlacMetadataBlock, FlacMetadataErrorCode, FlacMetadataOptions, FlacMetadataResult, FlacMetadataSource, FlacStreamInfo } from './metadata-types.js';
export class FlacMetadataError extends Error {
 constructor(readonly code: FlacMetadataErrorCode, message: string) { super(message); this.name = 'FlacMetadataError'; }
}
const fail = (code: FlacMetadataErrorCode, message: string): never => { throw new FlacMetadataError(code, message); };
/** Foundation only. Unhandled pictures stop because their effective end requires payload parsing.
 * Comments, seek tables and cue sheets are explicitly unvalidated. Provider buffers
 * are borrowed; only allocator-owned scratch storage is released here.
 */
export async function readFlacMetadata(input: FlacMetadataSource, options: FlacMetadataOptions): Promise<FlacMetadataResult> {
 const { resources, signal, checkpoint, maxReadBytes = 65536, maxMetadataBlocks = 1024, maxMetadataBytes = 67108864n, handleUnsupportedBlock } = options;
 if (typeof resources?.allocate !== 'function' || typeof signal?.throwIfAborted !== 'function') throw new TypeError('Metadata reader requires allocator and signal');
 signal.throwIfAborted();
 const size = input.size;
 if (typeof size !== 'bigint' || size < 0n || size > 0x7fffffffffffffffn || typeof input.readAt !== 'function') fail('invalid-input', 'Invalid metadata source');
 if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 1048576 || !Number.isSafeInteger(maxMetadataBlocks) || maxMetadataBlocks < 1 || maxMetadataBlocks > 1000000 || typeof maxMetadataBytes !== 'bigint' || maxMetadataBytes < 0n) fail('resource-limit', 'Invalid metadata limits');
 async function exact<T>(offset: bigint, length: number, consume: (bytes: Uint8Array) => T): Promise<T> {
  signal.throwIfAborted();
  if (offset + BigInt(length) > size) fail('invalid-data', 'Truncated FLAC metadata');
  const owned = resources.allocate(length);
  let released = false;
  const release = () => { if (!released) { released = true; signal.removeEventListener('abort', release); owned.release(); } };
  signal.addEventListener('abort', release, { once: true });
  try {
   signal.throwIfAborted();
   let written = 0;
   while (written < length) {
    await waitForFlacAbort(checkpoint?.(), signal); signal.throwIfAborted();
    const amount = Math.min(maxReadBytes, length - written);
    let chunk: Uint8Array;
    try { chunk = await waitForFlacAbort(input.readAt(offset + BigInt(written), amount, signal), signal); }
    catch (error) { signal.throwIfAborted(); throw new FlacMetadataError('input-read', `Metadata read failed: ${String(error)}`); }
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array) || chunk.length === 0 || chunk.length > amount) fail('input-read', 'Invalid metadata read');
    owned.data.set(chunk, written); written += chunk.length;
   }
   // Internal consumers synchronously produce scalars/frozen descriptors only.
   return consume(owned.data);
  } finally { release(); }
 }
 const marker = await exact(0n, Number(size < 4n ? size : 4n), bytes => Object.freeze({
  matches: bytes.length === 4 && bytes[0] === 102 && bytes[1] === 76 && bytes[2] === 97 && bytes[3] === 67,
  rateCode: (bytes[2] ?? 0) & 15,
 }));
 if (!marker.matches) {
  // avio_rl32 zero-pads a short marker; the rate nibble is byte two.
  const rates = [0,88200,176400,192000,8000,16000,22050,24000,32000,44100,48000,96000,0,0,0,0];
  return Object.freeze({ kind: 'raw-frame-fallback', framesOffset: 0n, sampleRateHint: rates[marker.rateCode] || null, metadataValidationComplete: false });
 }
 let offset = 4n, advertised = 0n, streamInfo: FlacStreamInfo | null = null;
 const blocks: FlacMetadataBlock[] = [], unparsed = new Set<number>();
 let continuation: Extract<FlacMetadataResult, {kind:'flac-streaminfo'}>['continuation'] = null;
 let last = false;
 while (!last) {
  signal.throwIfAborted();
  if (blocks.length >= maxMetadataBlocks) fail('resource-limit', 'Metadata block limit exceeded');
  const header = await exact(offset, 4, bytes => Object.freeze({type: bytes[0]! & 127, last: !!(bytes[0]! & 128), length: bytes[1]! * 65536 + bytes[2]! * 256 + bytes[3]!}));
  const {type, length} = header;
  last = header.last;
  advertised += 4n + BigInt(length);
  if (advertised > maxMetadataBytes) fail('resource-limit', 'Metadata byte limit exceeded');
  const payloadOffset = offset + 4n, end = payloadOffset + BigInt(length);
  if (end > size) fail('invalid-data', 'Truncated FLAC metadata payload');
  if (end - 4n > maxMetadataBytes) fail('resource-limit', 'Effective metadata byte limit exceeded');
  if (type === 0) {
   if (streamInfo !== null) fail('invalid-data', 'Duplicate FLAC STREAMINFO');
   if (length !== 34) fail('invalid-data', 'Invalid FLAC STREAMINFO size');
   streamInfo = await exact(payloadOffset, 34, bytes => {
   const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), word = view.getBigUint64(10, false);
   const sampleRate = Number(word >> 44n), totalSamples = word & ((1n << 36n) - 1n);
   const u24 = (at: number) => bytes[at]! * 65536 + bytes[at + 1]! * 256 + bytes[at + 2]!;
   return Object.freeze({ codec: 'flac', minBlockSamples: view.getUint16(0), maxBlockSamples: view.getUint16(2), minFrameBytes: u24(4), maxFrameBytes: u24(7), sampleRate, channels: Number((word >> 41n) & 7n) + 1, bitsPerSample: Number((word >> 36n) & 31n) + 1, totalSamples, totalSamplesKnown: totalSamples !== 0n, md5: Array.from(bytes.subarray(18), b => b.toString(16).padStart(2, '0')).join(''), timeBase: sampleRate ? Object.freeze({ num: 1n, den: BigInt(sampleRate) }) : null });
   });
  } else {
   // Native dispatches these three types before its generic first-block guard.
   if (!streamInfo && type !== 3 && type !== 5 && type !== 6) fail('invalid-data', 'STREAMINFO must precede this block');

  }
  let descriptor: FlacMetadataBlock = Object.freeze({ type, last, headerOffset: offset, payloadOffset, length, advertisedEndOffset: end, effectiveEndOffset: type === 6 ? null : end, validation: type === 0 ? 'streaminfo' : [3,4,5,6].includes(type) ? 'unhandled' : 'skipped' });
  if (descriptor.validation === 'unhandled' && handleUnsupportedBlock) {
   const handled = await waitForFlacAbort(handleUnsupportedBlock(descriptor), signal);
   signal.throwIfAborted();
   if (handled !== null && handled !== undefined) {
    if (typeof handled !== 'object' || typeof handled.effectiveEndOffset !== 'bigint' || typeof handled.payloadValidated !== 'boolean' || handled.effectiveEndOffset < end || handled.effectiveEndOffset > size || (type !== 6 && handled.effectiveEndOffset !== end)) fail('invalid-data', 'Invalid metadata handler result');
    if (handled.effectiveEndOffset - 4n > maxMetadataBytes) fail('resource-limit', 'Effective metadata byte limit exceeded');
    descriptor = Object.freeze({...descriptor, effectiveEndOffset: handled.effectiveEndOffset, validation: handled.payloadValidated ? 'validated' : 'unhandled'});
   }
  }
  if (descriptor.validation === 'unhandled') unparsed.add(type);
  blocks.push(descriptor);
  if (descriptor.effectiveEndOffset === null) { continuation = Object.freeze({ kind: 'unhandled-picture', blockIndex: blocks.length - 1, advertisedNextOffset: end }); break; }
  offset = descriptor.effectiveEndOffset;
  if (offset - 4n > maxMetadataBytes) fail('resource-limit', 'Effective metadata byte limit exceeded');
 }
 signal.throwIfAborted();
 return Object.freeze({ kind: 'flac-streaminfo', streamInfo, blocks: Object.freeze(blocks), advertisedMetadataBytes: advertised, effectiveMetadataBytes: continuation ? null : offset - 4n, framesOffset: continuation ? null : offset, directoryComplete: continuation === null, metadataValidationComplete: unparsed.size === 0, continuation, unparsedMetadataTypes: Object.freeze([...unparsed]), malformedMetadataParityVerified: false });
}
