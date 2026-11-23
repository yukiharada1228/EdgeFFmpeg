import type {openFlacDemux} from '@edge-ffmpeg/containers';
import type {FlacStreamIdentities,FlacStreamDescriptor} from './flac-selection.js';

/** Container comments belong to the container, not to audio stream metadata.
 * Picture usability requires pixel probing and is deliberately left unknown. */
export function flacStreamIdentities(demux:Awaited<ReturnType<typeof openFlacDemux>>):FlacStreamIdentities{
 const info=demux.metadata.kind==='flac-streaminfo'?demux.metadata.streamInfo:null;
 const audio:FlacStreamDescriptor=Object.freeze({streamId:0,tags:Object.freeze({}),dispositions:Object.freeze([]),
  ...(info&&info.sampleRate>0&&info.channels>0&&info.bitsPerSample>=4&&info.bitsPerSample<=32?{usable:true}:{})});
 const descriptors:FlacStreamDescriptor[]=[audio];
 const ids:number[]=[];
 for(const [index,picture] of demux.attachedPictures.entries()){
  const streamId=index+1;ids.push(streamId);
  descriptors.push(Object.freeze({streamId,
   ...(picture.descriptor.kind==='accepted'?{tags:picture.descriptor.tags}:{}),
   dispositions:Object.freeze(['attached_pic'])}));
 }
 return Object.freeze({audioStreamId:0,pictureStreamIds:Object.freeze(ids),streamDescriptors:Object.freeze(descriptors)});
}
