import { parseTimeDuration } from '@edge-ffmpeg/cli';
import { ExecutionError } from '@edge-ffmpeg/core';
export interface TimeOptions { seek: bigint; duration: bigint | null; stop: bigint | null }
export function timeOptions(): TimeOptions { return { seek: 0n, duration: null, stop: null }; }
export function setTimeOption(options: TimeOptions, name: string, value: string | null, signedVideoTime = false): boolean {
  if (!['-ss','-t','-to'].includes(name)) return false;
  let parsed: bigint;
  try { parsed = parseTimeDuration(value ?? ''); }
  catch (error) { throw new ExecutionError('invalid-time', error instanceof Error ? error.message : String(error)); }
  if (parsed < 0n && (!signedVideoTime || name === '-t')) throw new ExecutionError('unsupported-command', 'Negative media time options are not yet supported');
  if (name === '-ss') options.seek = parsed;
  else if (name === '-t') options.duration = parsed;
  else options.stop = parsed;
  return true;
}
export function resolveDuration(options: TimeOptions): bigint | null {
  if (options.duration !== null) return options.duration;
  if (options.stop === null) return null;
  if (options.stop <= options.seek) throw new ExecutionError('invalid-time', '-to must be greater than -ss');
  return options.stop - options.seek;
}
export function pcmPacketSpan(sampleRate: number): bigint {
  let span = 1n;
  while (span * 20n <= BigInt(sampleRate)) span *= 2n;
  return span;
}
/** PCM copy and re-encode have different FFmpeg trim boundary rules. */
export function pcmTimeRange(total: bigint, sampleRate: number, input: TimeOptions, output: TimeOptions, copy: boolean, maxFrames: bigint | null = null, outputSampleRate = sampleRate, packetSpan = pcmPacketSpan(sampleRate)): { start: bigint; samples: bigint; span: bigint; firstPacketSamples: bigint; pts: bigint } {
  const rate = BigInt(sampleRate), base = 1000000n;
  const nearOutput = (time: bigint) => (time * BigInt(outputSampleRate) + base / 2n) / base;
  const near = (time: bigint) => (time * rate + base / 2n) / base;
  // Pinned WAV PCM default packet span: largest power of two <= rate/10, minimum one sample.
  // This models selection boundaries independently of our bounded I/O packet size.
  const span = packetSpan;
  const ceil = (time: bigint) => ((time * rate + base * span - 1n) / (base * span)) * span;
  const durationFrames = (time: bigint) => copy ? ceil(time) : near(time);
  const inputStart = near(input.seek), outputOffset = copy ? ceil(output.seek) : nearOutput(output.seek);
  const start = inputStart + outputOffset;
  let end = total;
  const inputDuration = resolveDuration(input), outputDuration = resolveDuration(output);
  // The native decoded-input trim treats a zero-sample duration as a disabled limit.
  if (inputDuration !== null && (copy || near(inputDuration) > 0n) && inputStart + durationFrames(inputDuration) < end) end = inputStart + durationFrames(inputDuration);
  if (outputDuration !== null) {
    let stop: bigint;
    if (copy) stop = inputStart + ceil(output.seek + outputDuration);
    // A positive output limit rounded to zero samples lets the first native frame through.
    else if (outputDuration > 0n && nearOutput(outputDuration) === 0n) stop = inputStart + (outputOffset / span + 1n) * span;
    else stop = start + nearOutput(outputDuration);
    if (stop < end) end = stop;
  }
  const firstPacketSamples = copy ? span : span - outputOffset % span;
  if (maxFrames !== null) {
    if (maxFrames < 0n) throw new ExecutionError('invalid-arguments','Negative normalized PCM frame limit');
    const limitedSamples = maxFrames === 0n ? 0n : firstPacketSamples + (maxFrames - 1n) * span;
    if (start + limitedSamples < end) end = start + limitedSamples;
  }
  const boundedStart = start > total ? total : start;
  return { start: boundedStart, samples: end > boundedStart ? end - boundedStart : 0n, span, firstPacketSamples, pts: copy ? outputOffset - near(output.seek) : 0n };
}

export function setVideoTimeOption(options:TimeOptions,name:string,value:string|null):boolean{return setTimeOption(options,name,value,true);}
