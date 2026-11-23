import {Mp4Error} from './boxes.js';
/** AAC-LC frame length from the decoder-specific descriptor, without decoding. */
export interface AacConfiguration {readonly frameSamples:number;readonly channels:number;readonly sampleRate:number}
export function aacConfiguration(entry:Uint8Array):AacConfiguration|undefined {
 const view=new DataView(entry.buffer,entry.byteOffset,entry.byteLength);
 function descriptors(start:number,end:number,depth=0):AacConfiguration|undefined {
  if(depth>16)throw new Mp4Error('resource-budget','MP4 descriptor nesting limit');
  for(let at=start;at<end;){const tag=entry[at++]!;let size=0,done=false;for(let i=0;i<4;i++){if(at>=end)throw new Mp4Error('invalid-data','Truncated MP4 descriptor');const byte=entry[at++]!;size=size*128+(byte&127);if(!(byte&128)){done=true;break;}}if(!done||size>end-at)throw new Mp4Error('invalid-data','Invalid MP4 descriptor bounds');const finish=at+size;
   if(tag===5){if(size<2)throw new Mp4Error('invalid-data','Truncated AAC configuration');let bit=at*8;const readBits=(count:number)=>{if(bit+count>finish*8)throw new Mp4Error('invalid-data','Truncated AAC configuration bits');let value=0;for(let i=0;i<count;i++,bit++)value=value*2+((entry[Math.floor(bit/8)]!>>>(7-(bit&7)))&1);return value;};const object=readBits(5);if(object!==2)return undefined;const frequency=readBits(4);if(frequency===13||frequency===14)return undefined;const sampleRate=frequency===15?readBits(24):[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350][frequency]!,channels=readBits(4);if(channels===0||channels>7)return undefined;return {frameSamples:readBits(1)?960:1024,channels:channels===7?8:channels,sampleRate};}
   let nested=at;if(tag===3){if(size<3)throw new Mp4Error('invalid-data','Truncated ES descriptor');const flags=entry[at+2]!;nested+=3;if(flags&128)nested+=2;if(flags&64){if(nested>=finish)throw new Mp4Error('invalid-data','Truncated ES URL');nested+=1+entry[nested]!;}if(flags&32)nested+=2;}else if(tag===4)nested+=13;else{at=finish;continue;}if(nested>finish)throw new Mp4Error('invalid-data','Truncated nested descriptor');const result=descriptors(nested,finish,depth+1);if(result)return result;at=finish;
  }return undefined;
 }
 for(let at=36;at<entry.length;){if(entry.length-at<8)throw new Mp4Error('invalid-data','Truncated audio extension');const size=view.getUint32(at);if(size<8||size>entry.length-at)throw new Mp4Error('invalid-data','Invalid audio extension');if(String.fromCharCode(...entry.subarray(at+4,at+8))==='esds'){if(size<12)throw new Mp4Error('invalid-data','Truncated esds');return descriptors(at+12,at+size);}at+=size;}return undefined;
}

export function aacFrameSamples(entry:Uint8Array):number|undefined{return aacConfiguration(entry)?.frameSamples;}
