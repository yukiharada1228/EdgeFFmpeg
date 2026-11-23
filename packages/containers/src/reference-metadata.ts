/** Serialization identity of the fixed compatibility target, not the executing engine. */
export const ffmpegReferenceMuxerSoftware = 'Lavf63.1.102';
export type ReferenceMetadataProfile = 'ffmpeg-9.0.2';
/** Low-level APIs retain their existing identity unless a compatibility profile is selected. */
export function muxerSoftware(profile?:ReferenceMetadataProfile):string{
 if(profile===undefined)return 'EdgeFFmpeg';
 if(profile!=='ffmpeg-9.0.2')throw new RangeError('Unsupported reference metadata profile');
 return ffmpegReferenceMuxerSoftware;
}
