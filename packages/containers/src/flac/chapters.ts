// SPDX-License-Identifier: LGPL-2.1-or-later
/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * oggparsevorbis.c (Michael Ahlberg, Måns Rullgård, MIT), and
 * demux_utils.c/demux.c (Fabrice Bellard, LGPL-2.1-or-later).
 * Scope: Vorbis chapters, zero format start, caller-supplied duration only.
 * CUESHEET interaction and inferred format durations are not implemented.
 * Synchronous string state: no reads, checkpoints, or owned byte buffers.
 */
export interface VorbisChapter {
 readonly id: number;
 readonly timeBase: {readonly num: bigint; readonly den: bigint};
 readonly start: bigint;
 readonly end: bigint;
 readonly tags: Readonly<Record<string, string>>;
}
export interface VorbisChapterSnapshotOptions {readonly durationUs?: bigint | null}
export interface VorbisChapterOptions {readonly maxChapters?: number}
/** Structural hook accepted by comment collectors; true means consumed. */
export interface VorbisChapterHook {consume(key: string, value: string): boolean}
export interface VorbisChapterState extends VorbisChapterHook {
 accept(key: string, value: string): boolean;
 snapshot(options?: VorbisChapterSnapshotOptions): readonly VorbisChapter[];
 finish(options?: VorbisChapterSnapshotOptions): readonly VorbisChapter[];
}
interface MutableChapter {id: number; start: bigint; title: string | null}
function integer(text: string, at: number, width: number): {value: number; end: number} | null {
 while (at < text.length && /[\x09-\x0d ]/.test(text.charAt(at))) at++;
 const start = at;
 let sign = 1;
 if (text[at] === '+' || text[at] === '-') sign = text[at++] === '-' ? -1 : 1;
 let digits = 0, value = 0;
 while (at < text.length && at - start < width && /[0-9]/.test(text.charAt(at))) {
  value = value * 10 + Number(text[at++]); digits++;
 }
 return digits ? {value: value * sign, end: at} : null;
}
function time(text: string): bigint | null {
 let at = 0;
 const values: number[] = [];
 for (const [i, width] of [2, 2, 2, 3].entries()) {
  const part = integer(text, at, width);
  if (!part) return null;
  values.push(part.value); at = part.end;
  if (i < 3 && text[at++] !== (i === 2 ? '.' : ':')) return null;
 }
 return BigInt(values[3]! + 1000 * (values[2]! + 60 * (values[1]! + 60 * values[0]!)));
}
/** UTF-8 byte length branch without allocating an unaccounted encoded copy. */
function keyByteLength(key: string): number {
 let length = 0;
 for (const char of key) {
  const cp = char.codePointAt(0)!;
  length += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  if (length > 10) return length;
 }
 return length;
}
export function createVorbisChapterState({maxChapters = 1000}: VorbisChapterOptions = {}): VorbisChapterState {
 if (!Number.isSafeInteger(maxChapters) || maxChapters < 1) throw new RangeError('Invalid chapter limit');
 const chapters: MutableChapter[] = [];
 function consume(key: string, value: string): boolean {
  const length = keyByteLength(key);
  if (length < 9 || key.slice(0, 7).replace(/[a-z]/g, c => c.toUpperCase()) !== 'CHAPTER') return false;
  const number = integer(key, 7, 3);
  if (!number) return false;
  if (length <= 10) {
   const start = time(value);
   if (start === null) return false;
   let chapter = chapters.find(c => c.id === number.value);
   if (!chapter) {
    if (chapters.length >= maxChapters) throw new RangeError('FLAC chapter budget exceeded');
    chapter = {id: number.value, start, title: null}; chapters.push(chapter);
   }
   chapter.start = start; chapter.title = null; return true;
  }
  if (key.slice(-4).toUpperCase() !== 'NAME') return false;
  const chapter = chapters.find(c => c.id === number.value);
  if (!chapter) return false;
  chapter.title = value; return true;
 }
 function snapshot({durationUs = null}: VorbisChapterSnapshotOptions = {}): readonly VorbisChapter[] {
  if (durationUs !== null && (typeof durationUs !== 'bigint' || durationUs < 0n)) throw new RangeError('Invalid chapter duration');
  const ordered = chapters.slice().sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id);
  const ends = new Map<number, bigint>();
  const maximum = durationUs !== null && durationUs > 0n ? (durationUs + 500n) / 1000n : null;
  for (const [i, chapter] of ordered.entries()) {
   const next = ordered[i + 1];
   let end = maximum;
   if (next && next.start > chapter.start && (end === null || next.start < end)) end = next.start;
   ends.set(chapter.id, end === null || end < chapter.start ? chapter.start : end);
  }
  return Object.freeze(chapters.map(c => Object.freeze({id: c.id, timeBase: Object.freeze({num: 1n, den: 1000n}), start: c.start, end: ends.get(c.id)!, tags: Object.freeze(c.title === null ? {} : {title: c.title})})));
 }
 return {consume, accept: consume, snapshot, finish: snapshot};
}
