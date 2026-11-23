import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createH264Decoder,validateH264DecoderOptions} from './decoder.js';import type {H264DecoderOptions} from './decoder.js';import {H264InputError,H264ResourceError,inspectH264AnnexB} from './sps.js';
function limits(maxBytes:number,maxNalUnits:number){for(const value of [maxBytes,maxNalUnits])if(!Number.isSafeInteger(value)||value<1||value>2147483647)throw new H264InputError('Invalid AVC resource budget');}
export interface AvcConfiguration {readonly lengthSize:1|2|3|4;readonly parameterSets:Uint8Array}
/** AVCDecoderConfigurationRecord uses the pinned Native masking/trailing policy. */
export function parseAvcConfiguration(data:Uint8Array,maxBytes:number,maxNalUnits:number):AvcConfiguration {
 limits(maxBytes,maxNalUnits);
 if(!(data instanceof Uint8Array)||data.length<7||data[0]!==1)throw new H264InputError('Invalid AVC configuration record');
 if(data.length>maxBytes)throw new H264ResourceError('packet-bytes','AVC configuration exceeds allocation budget');
 data=new Uint8Array(data);
 let at=6,count=data[5]!&31,total=0,units=0;const nals:Uint8Array[]=[];
 for(let group=0;group<2;group++){
  for(let i=0;i<count;i++){if(++units>maxNalUnits)throw new H264ResourceError('nal-units','AVC parameter-set bound exceeded');if(at+2>data.length)throw new H264InputError('Truncated AVC parameter-set length');const length=data[at]!*256+data[at+1]!;at+=2;if(at+length>data.length)throw new H264InputError('Truncated AVC parameter set');if(length){total+=length+4;if(total>maxBytes)throw new H264ResourceError('packet-bytes','AVC parameter sets exceed allocation budget');nals.push(data.subarray(at,at+length));}at+=length;}
  if(group===0){if(at>=data.length)throw new H264InputError('Missing AVC PPS count');count=data[at++]!;}
 }
 const parameterSets=new Uint8Array(total);at=0;for(const nal of nals){parameterSets.set([0,0,0,1],at);parameterSets.set(nal,at+4);at+=nal.length+4;}
 return Object.freeze({lengthSize:((data[4]!&3)+1) as 1|2|3|4,parameterSets});
}
export function avcPacketToAnnexB(data:Uint8Array,lengthSize:1|2|3|4,maxBytes:number,maxNalUnits:number,prefix?:Uint8Array):Uint8Array {
 limits(maxBytes,maxNalUnits);
 if(!(data instanceof Uint8Array)||data.length<1||![1,2,3,4].includes(lengthSize))throw new H264InputError('Invalid AVC packet or length prefix');
 if(data.length>maxBytes)throw new H264ResourceError('packet-bytes','AVC packet exceeds allocation budget');
 if(prefix!==undefined){if(!(prefix instanceof Uint8Array))throw new H264InputError('Invalid AVC parameter prefix');if(prefix.length>maxBytes)throw new H264ResourceError('packet-bytes','AVC parameter prefix exceeds allocation budget');}
 data=new Uint8Array(data);if(prefix)prefix=new Uint8Array(prefix);
 let at=0,total=prefix?.length??0,units=0;const nals:Uint8Array[]=[];
 while(at<data.length){if(++units>maxNalUnits)throw new H264ResourceError('nal-units','AVC packet NAL bound exceeded');if(at+lengthSize>data.length)throw new H264InputError('Truncated AVC packet length prefix');let length=0;for(let i=0;i<lengthSize;i++)length=length*256+data[at++]!;if(length>data.length-at)throw new H264InputError('Truncated AVC packet NAL');if(length){total+=length+4;if(total>maxBytes)throw new H264ResourceError('packet-bytes','AVC converted packet exceeds allocation budget');nals.push(data.subarray(at,at+length));}at+=length;}
 if(total>maxBytes)throw new H264ResourceError('packet-bytes','AVC converted packet exceeds allocation budget');
 const output=new Uint8Array(total);if(prefix)output.set(prefix);at=prefix?.length??0;for(const nal of nals){output.set([0,0,0,1],at);output.set(nal,at+4);at+=nal.length+4;}return output;
}
export function createAvcDecoder(module:WebAssembly.Module,configuration:Uint8Array,options:H264DecoderOptions){
 const settings=validateH264DecoderOptions(options),parsed=parseAvcConfiguration(configuration,settings.maxPacketBytes,settings.maxNalUnits);if(parsed.parameterSets.length)inspectH264AnnexB(parsed.parameterSets,settings.maxFrameBytes,settings.maxNalUnits);
 const codec=createH264Decoder(module,{...settings,maxResidentBytes:settings.maxResidentBytes-2*parsed.parameterSets.length});const lengthSize=parsed.lengthSize;let prefix:Uint8Array|undefined=parsed.parameterSets;
 return Object.freeze({get parameters(){return codec.parameters;},get memoryBytes(){return codec.memoryBytes;},get peakWasmMemoryBytes(){return codec.peakWasmMemoryBytes;},get pendingPackets(){return codec.pendingPackets;},get isClosed(){return codec.isClosed;},
 feed(packet:MediaPacket){try{settings.signal?.throwIfAborted();const converted=avcPacketToAnnexB(packet.data,lengthSize,settings.maxPacketBytes,settings.maxNalUnits,prefix),result=codec.feed({...packet,data:converted});prefix=undefined;return result;}catch(error){prefix=undefined;try{codec.close();}catch(cleanup){throw new AggregateError([error,cleanup],'AVC conversion and decoder cleanup failed');}throw error;}},
 flush(){prefix=undefined;return codec.flush();},close(){prefix=undefined;codec.close();}
 });
}
