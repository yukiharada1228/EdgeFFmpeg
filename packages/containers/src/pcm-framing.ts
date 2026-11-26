import type { MediaPacket, AudioPacketSchedule } from '@edge-ffmpeg/avutil';

/** Native packet boundaries of the selected PCM range (ContainerMuxOptions.framing): a span, an optional shorter first packet, a resampled packet schedule or padding sections. */
export interface PcmFraming {
  readonly blockAlign: number;
  readonly samplesPerPacket: bigint;
  readonly firstPacketSamples?: bigint;
  readonly sampleCount: bigint;
  readonly startPts?: bigint;
  readonly packetSchedule?:AudioPacketSchedule;
  readonly sections?:readonly {readonly samples:bigint;readonly span:bigint;readonly firstPacketSamples?:bigint}[];
}
/** One bounded piece of a native-boundary packet: pts and duration (samples) are the whole packet's, bytes is a view of the input chunk, and end marks the packet's last piece. */
export interface PcmFramedChunk {readonly pts:bigint;readonly duration:bigint;readonly bytes:Uint8Array;readonly end:boolean}
/** A validated framing, for framePcmPackets; label and fail name the consumer's errors ('Invalid framecrc framing'). */
export interface PcmFramingPlan {
  readonly blockAlign:number;readonly samplesPerPacket:bigint;readonly firstPacketSamples:bigint|undefined;readonly sampleCount:bigint;readonly startPts:bigint;
  readonly packetSchedule:Pick<AudioPacketSchedule,'sampleCount'|'packetCount'|'samplesForPackets'>|undefined;
  readonly sections:readonly {readonly samples:bigint;readonly span:bigint;readonly firstPacketSamples?:bigint}[]|undefined;
  readonly label:string;readonly fail:(message:string)=>Error;
}
export class PcmFramingError extends Error {}
/** Validates framing before the consumer writes anything; every refusal is fail(`Invalid <label> ...`). */
export function planPcmFraming(framing:PcmFraming,label:string,fail:(message:string)=>Error=message=>new PcmFramingError(message)):PcmFramingPlan{
  if (!Number.isSafeInteger(framing.blockAlign) || framing.blockAlign < 1 || framing.samplesPerPacket < 1n || framing.sampleCount < 0n || (framing.firstPacketSamples ?? framing.samplesPerPacket) < 1n || (framing.firstPacketSamples ?? framing.samplesPerPacket) > framing.samplesPerPacket || !framing.packetSchedule && framing.samplesPerPacket * BigInt(framing.blockAlign) > 2147483647n) throw fail(`Invalid ${label} framing`);
  const sections=framing.sections?Array.from(framing.sections,section=>section?{...section}:section):undefined;
  if(sections&&(!Array.isArray(sections)||sections.length>65||sections.some(section=>!section||typeof section.samples!=='bigint'||section.samples<1n||typeof section.span!=='bigint'||section.span<1n||(section.firstPacketSamples!==undefined&&(typeof section.firstPacketSamples!=='bigint'||section.firstPacketSamples<1n||section.firstPacketSamples>section.span))||section.span*BigInt(framing.blockAlign)>2147483647n)||sections.reduce((sum,section)=>sum+section.samples,0n)!==framing.sampleCount))throw fail(`Invalid ${label} packet sections`);
  const plan=framing.packetSchedule,packetSchedule=plan?{sampleCount:plan.sampleCount,packetCount:plan.packetCount,samplesForPackets:plan.samplesForPackets.bind(plan)}:undefined;
  if(packetSchedule&&(sections||typeof packetSchedule.sampleCount!=='bigint'||packetSchedule.sampleCount!==framing.sampleCount||typeof packetSchedule.packetCount!=='bigint'||packetSchedule.packetCount<0n||packetSchedule.packetCount>packetSchedule.sampleCount||(packetSchedule.packetCount===0n)!==(packetSchedule.sampleCount===0n)||packetSchedule.samplesForPackets(0n)!==0n||packetSchedule.samplesForPackets(packetSchedule.packetCount)!==packetSchedule.sampleCount))throw fail(`Invalid ${label} packet schedule`);
  return {blockAlign:framing.blockAlign,samplesPerPacket:framing.samplesPerPacket,firstPacketSamples:framing.firstPacketSamples,sampleCount:framing.sampleCount,startPts:framing.startPts??0n,packetSchedule,sections,label,fail};
}
/**
 * Regroups contiguous zero-based PCM chunks (pts = dts = sample offset, duration = samples, flags 1) to the native packet
 * boundaries of plan, without buffering a whole packet: each packet is yielded as views of the input chunks it spans.
 * A packet is complete only at its end piece; an input that stops early yields no end for its last packet, then throws.
 */
export async function* framePcmPackets(plan:PcmFramingPlan,packets:AsyncIterable<MediaPacket>,signal?:AbortSignal):AsyncGenerator<PcmFramedChunk,void,undefined>{
  const {blockAlign:align,sampleCount,packetSchedule,sections,label,fail}=plan;
  let received = 0n, emitted = 0n, groupSamples = 0n;
  let scheduledPacket=0n;
  const scheduledLimit=()=>{if(!packetSchedule||scheduledPacket===packetSchedule.packetCount)return 1n;const next=packetSchedule.samplesForPackets(scheduledPacket+1n);if(typeof next!=='bigint'||next<=emitted||next>sampleCount||(next-emitted)*BigInt(align)>2147483647n)throw fail(`Invalid ${label} scheduled packet`);return next-emitted;};
  let groupLimit = plan.firstPacketSamples ?? plan.samplesPerPacket;
  if(packetSchedule)groupLimit=scheduledLimit();
  let sectionIndex=0,sectionRemaining=sections?.[0]?.samples??0n;
  if(sections?.length){const first=sections[0]!.firstPacketSamples??sections[0]!.span;groupLimit=sectionRemaining<first?sectionRemaining:first;}
  for await (const packet of packets) {
    signal?.throwIfAborted();
    if (packet.data.length % align !== 0) throw fail(`Unaligned PCM ${label} chunk`);
    const samples = BigInt(packet.data.length / align);
    if (!packet.data.length || packet.data.length % align !== 0 || packet.pts !== received || packet.dts !== received || packet.duration !== samples || packet.flags !== 1 || received + samples > sampleCount) throw fail(`Invalid contiguous PCM ${label} chunks`);
    received += samples;
    let offset = 0;
    while (offset < packet.data.length) {
      signal?.throwIfAborted();
      // The final packet ends with the range, so its length is known at its first piece.
      const remaining = sampleCount - emitted, duration = groupLimit < remaining ? groupLimit : remaining;
      const available = BigInt((packet.data.length - offset) / align);
      const count = available < duration - groupSamples ? available : duration - groupSamples;
      const bytes = Number(count) * align;
      const piece = packet.data.subarray(offset,offset + bytes);
      offset += bytes; groupSamples += count;
      const end = groupSamples === duration;
      yield {pts:plan.startPts + emitted,duration,bytes:piece,end};
      if (end) {
        emitted += groupSamples;
        if(packetSchedule){scheduledPacket++;groupLimit=scheduledLimit();}
        else if(sections){sectionRemaining-=groupSamples;let span=sections[sectionIndex]?.span??1n;if(sectionRemaining===0n){sectionIndex++;sectionRemaining=sections[sectionIndex]?.samples??0n;span=sections[sectionIndex]?.firstPacketSamples??sections[sectionIndex]?.span??1n;}groupLimit=sectionRemaining>0n&&sectionRemaining<span?sectionRemaining:span;}
        else groupLimit=plan.samplesPerPacket;
        groupSamples = 0n;
      }
    }
  }
  if (received !== sampleCount || emitted !== sampleCount || (packetSchedule&&scheduledPacket!==packetSchedule.packetCount)) throw fail(`${label.charAt(0).toUpperCase()}${label.slice(1)} sample count mismatch`);
}
