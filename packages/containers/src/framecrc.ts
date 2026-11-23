import {muxerSoftware} from './reference-metadata.js';
import type {ReferenceMetadataProfile} from './reference-metadata.js';
import type { WriteHandle } from '@edge-ffmpeg/core';
import type { MediaPacket, PcmCodec, AudioPacketSchedule } from '@edge-ffmpeg/avutil';
import { rawPcmCodec } from './raw-pcm.js';

export class FrameCrcError extends Error {}
export interface FrameCrcAudioFormat {
  readonly codec: PcmCodec;
  readonly sampleRate: number;
  /** FFmpeg channel-layout description supplied by the stream planner. */
  readonly channelLayout: string;
}
export interface FrameCrcOptions {
  readonly maxWriteBytes: number;
  readonly bitexact?: boolean;
  readonly metadataProfile?: ReferenceMetadataProfile;
  readonly signal?: AbortSignal;
  /** Regroup contiguous zero-based PCM chunks without buffering a whole packet. */
  readonly framing?: {
    readonly blockAlign: number;
    readonly samplesPerPacket: bigint;
    readonly firstPacketSamples?: bigint;
    readonly sampleCount: bigint;
    readonly startPts?: bigint;
    readonly packetSchedule?:AudioPacketSchedule;
    readonly sections?:readonly {readonly samples:bigint;readonly span:bigint;readonly firstPacketSamples?:bigint}[];
  };
}
/** Adler-32 with the framecrc seed (zero), independently defined by modular sums. */
export function frameCrcChecksum(data: Uint8Array,signal?:AbortSignal): number {
  return updateChecksum(data, 0,signal);
}
function updateChecksum(data: Uint8Array, seed: number,signal?:AbortSignal): number {
  let a = seed & 65535, b = seed >>> 16;
  for (let index=0;index<data.length;index++) { if((index&4095)===0)signal?.throwIfAborted();a = (a + data[index]!) % 65521; b = (b + a) % 65521; }
  return (b * 65536 + a) >>> 0;
}
const minInt64 = -(1n << 63n), maxInt64 = (1n << 63n) - 1n;
function integer(value: bigint | null): string {
  if (value !== null && (value < minInt64 || value > maxInt64)) throw new FrameCrcError('Timestamp exceeds signed 64-bit range');
  return String(value ?? minInt64);
}
/**
 * Single PCM audio stream framecrc output. Without framing, packet boundaries
 * are semantic input: the caller must supply encoder/demuxer framing, rather
 * than arbitrary I/O chunks. No extradata or side-data representation yet.
 */
export async function muxFrameCrc(output: WriteHandle, format: FrameCrcAudioFormat, packets: AsyncIterable<MediaPacket>, options: FrameCrcOptions): Promise<void> {
  try {
    const { maxWriteBytes, signal } = options;
    signal?.throwIfAborted();
    const software=muxerSoftware(options.metadataProfile);
    if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes < 1 || !Number.isInteger(format.sampleRate) || format.sampleRate < 1 || format.sampleRate > 2147483647 || rawPcmCodec(format.codec.slice(4)) !== format.codec || !/^[a-zA-Z0-9 .()+_-]{1,128}$/.test(format.channelLayout)) throw new FrameCrcError('Invalid framecrc audio parameters');
    const framing = options.framing;
    if (framing && (!Number.isSafeInteger(framing.blockAlign) || framing.blockAlign < 1 || framing.samplesPerPacket < 1n || framing.sampleCount < 0n || (framing.firstPacketSamples ?? framing.samplesPerPacket) < 1n || (framing.firstPacketSamples ?? framing.samplesPerPacket) > framing.samplesPerPacket || !framing.packetSchedule && framing.samplesPerPacket * BigInt(framing.blockAlign) > 2147483647n)) throw new FrameCrcError('Invalid framecrc framing');
    const sections=framing?.sections?Array.from(framing.sections,section=>section?{...section}:section):undefined;
    if(sections&&(!Array.isArray(sections)||sections.length>65||sections.some(section=>!section||typeof section.samples!=='bigint'||section.samples<1n||typeof section.span!=='bigint'||section.span<1n||(section.firstPacketSamples!==undefined&&(typeof section.firstPacketSamples!=='bigint'||section.firstPacketSamples<1n||section.firstPacketSamples>section.span))||section.span*BigInt(framing!.blockAlign)>2147483647n)||sections.reduce((sum,section)=>sum+section.samples,0n)!==framing!.sampleCount))throw new FrameCrcError('Invalid framecrc packet sections');
    const plan=framing?.packetSchedule,packetSchedule=plan?{sampleCount:plan.sampleCount,packetCount:plan.packetCount,samplesForPackets:plan.samplesForPackets.bind(plan)}:undefined;
    if(packetSchedule&&(sections||typeof packetSchedule.sampleCount!=='bigint'||packetSchedule.sampleCount!==framing!.sampleCount||typeof packetSchedule.packetCount!=='bigint'||packetSchedule.packetCount<0n||packetSchedule.packetCount>packetSchedule.sampleCount||(packetSchedule.packetCount===0n)!==(packetSchedule.sampleCount===0n)||packetSchedule.samplesForPackets(0n)!==0n||packetSchedule.samplesForPackets(packetSchedule.packetCount)!==packetSchedule.sampleCount))throw new FrameCrcError('Invalid framecrc packet schedule');
    const encoder = new TextEncoder();
    const write = async (text: string) => {
      const bytes = encoder.encode(text);
      for (let offset = 0; offset < bytes.length; offset += maxWriteBytes) {
        signal?.throwIfAborted();
        await output.write(bytes.subarray(offset, offset + maxWriteBytes));
        signal?.throwIfAborted();
      }
    };
    if (!options.bitexact) await write('#software: '+software+'\n');
    await write(`#tb 0: 1/${format.sampleRate}\n#media_type 0: audio\n#codec_id 0: ${format.codec}\n#sample_rate 0: ${format.sampleRate}\n#channel_layout_name 0: ${format.channelLayout}\n`);
    const row = async (dts: bigint | null, pts: bigint | null, duration: bigint | null, size: number, crc: number, flags: number) => {
      const suffix = flags === 1 ? '' : `, F=0x${flags.toString(16).toUpperCase()}`;
      await write(`0, ${integer(dts).padStart(10)}, ${integer(pts).padStart(10)}, ${integer(duration ?? 0n).padStart(8)}, ${String(size).padStart(8)}, 0x${crc.toString(16).padStart(8,'0')}${suffix}\n`);
    };
    let received = 0n, emitted = 0n, groupSamples = 0n, checksum = 0;
    let scheduledPacket=0n;
    const scheduledLimit=()=>{if(!packetSchedule||scheduledPacket===packetSchedule.packetCount)return 1n;const next=packetSchedule.samplesForPackets(scheduledPacket+1n);if(typeof next!=='bigint'||next<=emitted||next>framing!.sampleCount||(next-emitted)*BigInt(framing!.blockAlign)>2147483647n)throw new FrameCrcError('Invalid framecrc scheduled packet');return next-emitted;};
    let groupLimit = framing?.firstPacketSamples ?? framing?.samplesPerPacket ?? 1n;
    if(packetSchedule)groupLimit=scheduledLimit();
    let sectionIndex=0,sectionRemaining=sections?.[0]?.samples??0n;
    if(sections?.length){const first=sections[0]!.firstPacketSamples??sections[0]!.span;groupLimit=sectionRemaining<first?sectionRemaining:first;}
    for await (const packet of packets) {
      signal?.throwIfAborted();
      if (packet.streamIndex !== 0 || packet.timeBase.num <= 0n || packet.timeBase.den !== packet.timeBase.num * BigInt(format.sampleRate) || !Number.isInteger(packet.flags) || packet.flags < 0 || packet.flags > 0x7fffffff || packet.data.length > 0x7fffffff) throw new FrameCrcError('Invalid framecrc packet');
      if (!framing) {
        await row(packet.dts,packet.pts,packet.duration,packet.data.length,frameCrcChecksum(packet.data,signal),packet.flags);
        continue;
      }
      const align = framing.blockAlign;
      if (packet.data.length % align !== 0) throw new FrameCrcError('Unaligned PCM framecrc chunk');
      const samples = BigInt(packet.data.length / align);
      if (!packet.data.length || packet.data.length % align !== 0 || packet.pts !== received || packet.dts !== received || packet.duration !== samples || packet.flags !== 1 || received + samples > framing.sampleCount) throw new FrameCrcError('Invalid contiguous PCM framecrc chunks');
      received += samples;
      let offset = 0;
      while (offset < packet.data.length) {
        signal?.throwIfAborted();
        const available = BigInt((packet.data.length - offset) / align);
        const count = available < groupLimit - groupSamples ? available : groupLimit - groupSamples;
        const bytes = Number(count) * align;
        checksum = updateChecksum(packet.data.subarray(offset,offset + bytes),checksum,signal);
        offset += bytes; groupSamples += count;
        if (groupSamples === groupLimit || (received === framing.sampleCount && offset === packet.data.length)) {
          const pts = (framing.startPts ?? 0n) + emitted;
          await row(pts,pts,groupSamples,Number(groupSamples) * align,checksum,1);
          emitted += groupSamples;
          if(packetSchedule){scheduledPacket++;groupLimit=scheduledLimit();}
          else if(sections){sectionRemaining-=groupSamples;let span=sections[sectionIndex]?.span??1n;if(sectionRemaining===0n){sectionIndex++;sectionRemaining=sections[sectionIndex]?.samples??0n;span=sections[sectionIndex]?.firstPacketSamples??sections[sectionIndex]?.span??1n;}groupLimit=sectionRemaining>0n&&sectionRemaining<span?sectionRemaining:span;}
          else groupLimit=framing.samplesPerPacket;
          groupSamples = 0n; checksum = 0;
        }
      }
    }
    if (framing && (received !== framing.sampleCount || emitted !== framing.sampleCount || (packetSchedule&&scheduledPacket!==packetSchedule.packetCount))) throw new FrameCrcError('Framecrc sample count mismatch');
    signal?.throwIfAborted();
    await output.commit();
  } catch (error) {
    try { await output.abort(error); } catch (abortError) { throw new AggregateError([error,abortError],'Framecrc output and abort failed'); }
    throw error;
  }
}
