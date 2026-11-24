export { openWav, WavError } from './wav.js';
export type { WavInfo, WavInput, WavOptions } from './wav.js';
export { muxWav, validateWavOutput, supportsWavCodec } from './wav-mux.js';
export type { WavPcmCodec, WavOutputFormat, WavMuxOptions } from './wav-mux.js';
export { createWavMuxState, serializeWavMuxState, deserializeWavMuxState, wavMuxPatches } from './wav-mux-state.js';
export type { WavMuxState, WavMuxStateOptions, WavMuxSnapshot, WavMuxPatch, WavMuxTrailer } from './wav-mux-state.js';
export { openRawPcm, muxRawPcm, rawPcmCodec, RawPcmError } from './raw-pcm.js';
export type { RawPcmFormat, RawPcmParameters, RawPcmOptions, RawPcmInfo, RawPcmInput, RawPcmMuxOptions } from './raw-pcm.js';
export { muxFrameCrc, frameCrcChecksum, FrameCrcError } from './framecrc.js';
export type { FrameCrcAudioFormat, FrameCrcOptions } from './framecrc.js';
export { openAiff, muxAiff, supportsAiffCodec, validateAiffOutput, AiffError } from './aiff.js';
export type { AiffCodec, AiffOptions, AiffInfo, AiffInput, AiffOutputFormat, AiffMuxOptions } from './aiff.js';
export { detectAudioContainer } from './detect.js';
export { openAu, muxAu, supportsAuCodec, validateAuOutput, AuError } from './au.js';
export type { AuCodec, AuOptions, AuInfo, AuInput, AuOutputFormat, AuMuxOptions } from './au.js';
export {openW64,probeW64,muxW64,validateW64Output,supportsW64Codec} from './w64.js';
export type {W64PcmCodec,W64OutputFormat,W64Options,W64Info,W64Input,W64MuxOptions} from './w64.js';
export {openRawVideo,muxRawVideo,muxRawVideoFrameCrc,RawVideoError} from './raw-video.js';
export type {RawVideoParameters,RawVideoOptions,RawVideoInfo,RawVideoInput,RawVideoMuxOptions} from './raw-video.js';

export {openMp4,Mp4Error} from './mp4/index.js';
export type {Mp4Options,Mp4Input,Mp4TrackInfo,Mp4Packet,Mp4PacketHeader} from './mp4/index.js';

export {muxMp4} from './mp4/mux.js';
export {planMp4Copy} from './mp4/copy-plan.js';
export type {Mp4MuxOptions} from './mp4/mux.js';
export type {Mp4MuxTrack,Mp4MuxSample} from './mp4/mux-metadata.js';

export {openBmpStream,BmpStreamError} from './bmp-stream.js';
export type {BmpStreamOptions} from './bmp-stream.js';

export {ffmpegReferenceMuxerSoftware,muxerSoftware} from './reference-metadata.js';
export type {ReferenceMetadataProfile} from './reference-metadata.js';

export {openFlacPacketRanges} from './flac/ranges.js';
export type {FlacRangeSource,FlacRangeAllocator,FlacRangeStreamOptions,FlacIntakeRange,FlacRangeStream,FlacDiscoveryMetrics} from './flac/types.js';
export {readFlacPacketChunks} from './flac/payload.js';
export type {FlacPacketChunk,FlacPacketChunkOptions,FlacPacketChunkReader} from './flac/types.js';

export {readFlacMetadata,FlacMetadataError} from './flac/metadata.js';
export type {FlacMetadataOptions,FlacMetadataResult,FlacMetadataBlock,FlacMetadataHandling,FlacMetadataSource,FlacMetadataErrorCode,FlacStreamInfo} from './flac/metadata-types.js';

export {createVorbisCommentCollector,parseVorbisCommentPayload,VorbisCommentLimitError} from './flac/vorbis-comment.js';
export {readVorbisCommentRange} from './flac/vorbis-comment-stream.js';
export type {VorbisCommentEntry,VorbisCommentOptions,VorbisCommentReadOptions,VorbisCommentResult,VorbisCommentDeferred} from './flac/comment-types.js';
export {createVorbisChapterState} from './flac/chapters.js';
export type {VorbisChapter,VorbisChapterState,VorbisChapterSnapshotOptions,VorbisChapterOptions} from './flac/chapters.js';
export {applyFlacChannelMask,resolveFlacLayout,parseReferenceLong} from './flac/channel-mask.js';
export type {FlacLayout,FlacMaskEntry,FlacChannelMaskResult} from './flac/channel-mask.js';
export {parseFlacPicturePayload,decodeReferenceBase64Into,FlacPictureLimitError} from './flac/pictures.js';
export {readFlacPictureRange} from './flac/picture-reader.js';
export {createReferenceBase64Source,Base64SourceLimitError} from './flac/base64-source.js';
export {FlacPictureMetadataError,FlacPictureContinuationRequired} from './flac/picture-errors.js';
export type {FlacPictureOptions,FlacPictureReadOptions,FlacPictureDescriptor} from './flac/picture-types.js';

export {openFlacDemux} from './flac/demux.js';
export type {FlacDemuxOptions,FlacDemuxPacket} from './flac/demux.js';

export {muxFlacFrameCrc} from './flac/framecrc.js';
export type {FlacFrameCrcFormat,FlacFrameCrcOptions} from './flac/framecrc.js';
export {muxFlac} from './flac/mux.js';
export type {FlacMuxOptions,FlacMuxMetadataPolicy} from './flac/mux.js';
