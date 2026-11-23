// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
export interface FlacFrameHeader {
 readonly kind:'candidate';readonly variable:boolean;readonly number:bigint;
 readonly channels:number;readonly channelMode:number;readonly bitsPerSample:number;
 readonly sampleRate:number;readonly blockSamples:number;readonly headerBytes:number;
 readonly inspectedBytes:number;readonly subframeType:number;readonly needsStreamInfo:boolean;
}
export type FlacHeaderResult=FlacFrameHeader|{readonly kind:'incomplete';readonly needed:number}|{readonly kind:'invalid';readonly reason:string};
export interface FlacHeaderCandidate {readonly offset:bigint;readonly header:FlacFrameHeader;readonly prefixCrc16:number}
export interface FlacScoredHeader extends Pick<FlacHeaderCandidate,'offset'|'header'> {readonly score:number;readonly bestOffset:bigint|null;readonly penalties:readonly number[]}
/** Offsets describe the logical FIFO's absolute source coordinates. EOF padding
 * has no physical offset. CRC prefixes use one common origin for all candidates. */
export interface FlacDiscoveryRequest {readonly physicalOffset:bigint|null;readonly bytes:number;readonly padding:boolean;readonly searchStart:bigint;readonly searchEndExclusive:bigint;readonly fifoStart:bigint;readonly fifoEnd:bigint}
/** Only these exact flag combinations are supported; flags remain fixed for the parser lifetime. */
export type FlacParserFlags=0|1|4096|4097;
/** offset is contiguous physical source position. pts/dts are signed64 bigint
 * timestamps in caller units (null/omitted = AV_NOPTS_VALUE; reserved INT64_MIN
 * must use null). pos is the Native caller position, -1 if unknown; the first
 * explicit pos initializes Native current/next offsets. If omitted, initial
 * offset preserves the descriptor API coordinate convention, while timestamp
 * slots record Native unknown position (-1). No timestamp rescaling occurs. */
export interface FlacParserInput {readonly offset:bigint;readonly bytes:number;readonly pts?:bigint|null;readonly dts?:bigint|null;readonly pos?:bigint}
/** Trusted equivalent of Native frame_header_is_valid, including header CRC and
 * first subframe policy. Inspect at most 17 bytes of caller-owned padded backing
 * storage at physicalOffset; bytes is the declared packet length, NOT the bound
 * of that backing storage. Caller must safely supply remaining backing bytes or
 * explicit zero padding; never read beyond supplied memory. EOF uses 17 zeros
 * internally and does not invoke this callback. Null means invalid, not incomplete.
 * No payload is passed to or retained by the descriptor parser. */
export interface FlacCompleteHeaderRequest {readonly physicalOffset:bigint;readonly bytes:number;readonly maxInspectedBytes:17}
export interface FlacCompleteHeader {readonly variable:boolean;readonly number:bigint;readonly blockSamples:number}
export interface FlacParserOptions {
 readonly flags?:FlacParserFlags;
 readonly inspectCompleteHeader?:(request:FlacCompleteHeaderRequest)=>FlacCompleteHeader|null|Promise<FlacCompleteHeader|null>;
 readonly discover:(request:FlacDiscoveryRequest)=>readonly FlacHeaderCandidate[]|Promise<readonly FlacHeaderCandidate[]>;
 readonly maxHeaders?:number;readonly maxCrcQueries?:number;readonly maxLogicalFifoBytes?:number;
}
export interface FlacPacketRange {readonly kind:'frame'|'junk';readonly sourceOffset:bigint;readonly bytes:bigint;readonly parserDuration:number;readonly codecPts:bigint|null}
/** Parser fields reflect AVCodecParserContext after EVERY call, even without a
 * packet. parserDuration can be stale after invalid complete headers or EOF.
 * parserPts is caller/fetched PTS unless USE_CODEC_TS overwrites it; DTS is never
 * replaced by codecPts. Final fixed-block streaming frames do not overwrite PTS.
 * timestampOffset is Native s->offset, not the packet's sourceOffset.
 * frameOffset remains null without output for compatibility with this API. */
export interface FlacParserResult {readonly consumed:number;readonly rawIndex:number;readonly packet:FlacPacketRange|null;readonly frameOffset:bigint|null;readonly nextFrameOffset:bigint;readonly currentOffset:bigint;readonly parserPts:bigint|null;readonly parserDts:bigint|null;readonly parserPos:bigint;readonly timestampOffset:bigint;readonly parserDuration:number}
export interface FlacParserMetrics {readonly calls:number;readonly blockedCalls:number;readonly logicalFifoBytes:number;readonly logicalFifoCapacity:number;readonly headers:number;readonly sourcePayloadRetained:false;readonly eofPadded:boolean;readonly closed:boolean;readonly failed:boolean}
export interface FlacDescriptorParser {parse(input:FlacParserInput):Promise<FlacParserResult>;close():void;readonly metrics:FlacParserMetrics}
