// SPDX-License-Identifier: LGPL-2.1-or-later
// VUI field order follows pinned h264_ps.c/h2645_vui.c; see NOTICE.
import {H264InputError,H264ResourceError} from './errors.mjs';
export {H264InputError,H264ResourceError} from './errors.mjs';
class Bits {
 private position=0;
 constructor(private readonly bytes:Uint8Array){}
 read(count:number):number{if(count<0||count>32||this.position+count>this.bytes.length*8)throw new H264InputError('Truncated H264 SPS');let value=0;for(let i=0;i<count;i++){value=value*2+((this.bytes[this.position>>3]!>>(7-(this.position&7)))&1);this.position++;}return value;}
 ue(max=2147483647):number{let zeros=0;while(this.read(1)===0)if(++zeros>31)throw new H264InputError('H264 Exp-Golomb overflow');const value=2**zeros-1+this.read(zeros);if(value>max)throw new H264InputError('H264 parameter exceeds supported range');return value;}
 se():number{const value=this.ue();return value&1?(value+1)/2:-value/2;}
}
/** Parse only required NAL header bits; entropy payload belongs to the codec. */
class NalHeaderBits extends Bits {
 private raw=1;private zeros=0;private byte=0;private remaining=0;
 constructor(private readonly nal:Uint8Array){super(new Uint8Array());}
 override read(count:number):number{
  if(count<0||count>32)throw new H264InputError('Invalid H264 header bit count');let value=0;
  for(let i=0;i<count;i++){
   if(!this.remaining){if(this.raw>=this.nal.length)throw new H264InputError('Truncated H264 NAL header');let byte=this.nal[this.raw++]!;if(this.zeros===2&&byte===3){if(this.raw>=this.nal.length||this.nal[this.raw]!>3)throw new H264InputError('Invalid H264 emulation prevention');this.zeros=0;byte=this.nal[this.raw++]!;}this.zeros=byte===0?Math.min(2,this.zeros+1):0;this.byte=byte;this.remaining=8;}
   value=value*2+((this.byte>>(--this.remaining))&1);
  }
  return value;
 }
}
function bitsForNal(nal:Uint8Array):Bits{
 const rbsp=new Uint8Array(nal.length-1);let count=0,zeros=0;
 for(let i=1;i<nal.length;i++){const byte=nal[i]!;if(zeros===2&&byte===3){if(i+1>=nal.length||nal[i+1]!>3)throw new H264InputError('Invalid H264 emulation prevention');zeros=0;continue;}rbsp[count++]=byte;zeros=byte===0?zeros+1:0;if(zeros>2)zeros=2;}
 return new Bits(rbsp.subarray(0,count));
}
export interface H264Sps {readonly id:number;readonly profile:number;readonly level:number;readonly width:number;readonly height:number;readonly codedWidth:number;readonly codedHeight:number;readonly references:number;readonly chroma:number;readonly bitDepth:number;readonly frameOnly:boolean;readonly fullRange:boolean;readonly restricted:boolean;readonly maxReorder:number;readonly signalPresent:boolean;readonly sarNum:number;readonly sarDen:number;readonly matrix:number|null;readonly timingNum:number;readonly timingDen:number}
/** Parameter inspection is independent of the external decoder and runs before it. */
export function inspectH264Sps(nal:Uint8Array,maxFrameBytes:number):H264Sps {
 if(nal.length<4||(nal[0]!&31)!==7||(nal[0]!&128)!==0)throw new H264InputError('Invalid H264 SPS NAL');
 const bits=bitsForNal(nal),profile=bits.read(8);bits.read(8);const level=bits.read(8),id=bits.ue(31);if(![66,77,88,100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile))throw new H264InputError('Unsupported H264 SPS profile');let chroma=1,bitDepth=8,separate=false;
 if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
  chroma=bits.ue(3);if(chroma===3)separate=!!bits.read(1);bitDepth=8+bits.ue(6);const chromaDepth=8+bits.ue(6);bits.read(1);
  if(bitDepth!==8||chromaDepth!==8||chroma!==1)throw new H264InputError('H264 decoder currently requires eight-bit 4:2:0 samples');
  if(bits.read(1))for(let i=0;i<8;i++)if(bits.read(1)){let last=8,next=8;for(let j=0;j<(i<6?16:64);j++){if(next!==0){const delta=bits.se();if(delta< -128||delta>127)throw new H264InputError('Invalid H264 scaling-list delta');next=(last+delta+256)%256;}if(next!==0)last=next;}}
 }
 bits.ue(12);const order=bits.ue(2);if(order===0)bits.ue(12);else if(order===1){bits.read(1);bits.se();bits.se();const cycle=bits.ue(255);for(let i=0;i<cycle;i++)bits.se();}
 const references=bits.ue(16);bits.read(1);const codedWidth=(bits.ue(1048575)+1)*16,mapHeight=bits.ue(1048575)+1,frameOnly=!!bits.read(1);if(!frameOnly)bits.read(1);bits.read(1);
 const codedHeight=mapHeight*16*(frameOnly?1:2);let left=0,right=0,top=0,bottom=0;if(bits.read(1)){left=bits.ue();right=bits.ue();top=bits.ue();bottom=bits.ue();}
 const cropX=separate||chroma===0?1:2,cropY=(frameOnly?1:2)*(separate||chroma===0?1:chroma===1?2:1),width=codedWidth-(left+right)*cropX,height=codedHeight-(top+bottom)*cropY;
 if(width<1||height<1)throw new H264InputError('Invalid H264 crop bounds');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)throw new H264InputError('Invalid H264 frame byte budget');
 if(codedWidth*codedHeight*3/2>maxFrameBytes)throw new H264ResourceError('frame-bytes','H264 coded frame exceeds allocation budget');
 const vui=bits.read(1)?readVui(bits):{fullRange:false,restricted:false,maxReorder:0,signalPresent:false,sarNum:0,sarDen:1,matrix:null,timingNum:0,timingDen:1};
 return Object.freeze({...vui,id,profile,level,width,height,codedWidth,codedHeight,references,chroma,bitDepth,frameOnly});
}
function readHrd(bits:Bits){const count=bits.ue(31)+1;bits.read(8);for(let i=0;i<count;i++){bits.ue(4294967294);bits.ue(4294967294);bits.read(1);}bits.read(20);}
const SAR_TABLE:readonly (readonly [number,number])[]=[[0,1],[1,1],[12,11],[10,11],[16,11],[40,33],[24,11],[20,11],[32,11],[80,33],[18,11],[15,11],[64,33],[160,99],[4,3],[3,2],[2,1]];
function readVui(bits:Bits){
 let sarNum=0,sarDen=1;if(bits.read(1)){const aspect=bits.read(8);if(aspect===255){sarNum=bits.read(16);sarDen=bits.read(16);if(!sarNum||!sarDen){sarNum=0;sarDen=1;}}else if(SAR_TABLE[aspect]){[sarNum,sarDen]=SAR_TABLE[aspect]!;}}
 if(bits.read(1))bits.read(1);
 const signalPresent=!!bits.read(1);let fullRange=false,matrix:number|null=null;if(signalPresent){bits.read(3);fullRange=!!bits.read(1);if(bits.read(1)){bits.read(8);bits.read(8);const value=bits.read(8);matrix=value===3||value>17?2:value;}}
 if(bits.read(1)){bits.ue();bits.ue();}
 let timingNum=0,timingDen=1;if(bits.read(1)){const units=bits.read(32),scale=bits.read(32);bits.read(1);if(units&&scale){timingNum=scale;timingDen=2*units;}}
 const nalHrd=!!bits.read(1);if(nalHrd)readHrd(bits);const vclHrd=!!bits.read(1);if(vclHrd)readHrd(bits);if(nalHrd||vclHrd)bits.read(1);bits.read(1);
 const restricted=!!bits.read(1);let maxReorder=0;if(restricted){bits.read(1);bits.ue();bits.ue();bits.ue();bits.ue();maxReorder=bits.ue(16);bits.ue();}
 return {fullRange,restricted,maxReorder,signalPresent,sarNum,sarDen,matrix,timingNum,timingDen};
}
export interface H264Nal {readonly data:Uint8Array;readonly type:number;readonly sps?:H264Sps}
export interface H264Inspection {readonly hasVcl:boolean;readonly parameterSets:readonly H264Sps[];readonly units:readonly H264Nal[]}
export class H264ParameterSets {
 private readonly sps=new Map<number,H264Sps>();private readonly pps=new Map<number,H264Sps>();
 private pixelFormat:'yuv420p'|'yuvj420p'|undefined;private geometry:readonly number[]|undefined;private sarNum=0;private sarDen=1;private matrix=2;private fullRange=false;private colorRange=0;
 clear(){this.sps.clear();this.pps.clear();this.pixelFormat=undefined;this.geometry=undefined;this.sarNum=0;this.sarDen=1;this.matrix=2;this.fullRange=false;this.colorRange=0;}
 get pictureColorRange(){return this.colorRange;}
 get pictureColorSpace(){return this.matrix;}
 /** Match Native's retained pixel-format choice until context reinitialization. */
 formatForPicture(sps:H264Sps):'yuv420p'|'yuvj420p'{
  const geometry=[sps.codedWidth,sps.codedHeight,sps.bitDepth,sps.chroma];let reinit=!this.pixelFormat||geometry.some((v,i)=>v!==this.geometry?.[i])||sps.sarNum*this.sarDen!==this.sarNum*sps.sarDen;
  if(sps.signalPresent){this.fullRange=sps.fullRange;this.colorRange=sps.fullRange?2:1;if(sps.matrix!==null){if(sps.matrix!==this.matrix)reinit=true;this.matrix=sps.matrix;}}
  this.geometry=geometry;this.sarNum=sps.sarNum;this.sarDen=sps.sarDen;if(reinit)this.pixelFormat=this.fullRange?'yuvj420p':'yuv420p';return this.pixelFormat!;
 }
 update(inspection:H264Inspection):H264Sps|undefined{
  let active:H264Sps|undefined;
  for(const unit of inspection.units){
   if(unit.sps)this.sps.set(unit.sps.id,unit.sps);
   else if(unit.type===8){const bits=new NalHeaderBits(unit.data),id=bits.ue(255),spsId=bits.ue(31),sps=this.sps.get(spsId);if(!sps)throw new H264InputError('H264 sequence parameter set is not available');this.pps.set(id,sps);}
   else if(unit.type===1||unit.type===2||unit.type===5){const bits=new NalHeaderBits(unit.data);bits.ue();bits.ue(9);const pps=bits.ue(255),selected=this.pps.get(pps);if(!selected)throw new H264InputError('H264 picture parameter set is not available');if(active&&(active.fullRange!==selected.fullRange||active.restricted!==selected.restricted||active.maxReorder!==selected.maxReorder||active.codedWidth!==selected.codedWidth||active.codedHeight!==selected.codedHeight))throw new H264InputError('Mixed H264 picture parameter sets');active=selected;}
  }
  if(inspection.hasVcl&&!active)throw new H264InputError('H264 partition access units are not connected yet');return active;
 }
}
export function inspectH264AnnexB(data:Uint8Array,maxFrameBytes:number,maxNalUnits:number):H264Inspection {
 const starts:{start:number;prefix:number}[]=[];
 for(let i=0;i+2<data.length;){if(data[i]===0&&data[i+1]===0&&(data[i+2]===1||data[i+2]===0&&data[i+3]===1)){const prefix=data[i+2]===1?3:4;if(starts.length>=maxNalUnits)throw new H264ResourceError('nal-units','H264 NAL count exceeds budget');starts.push({start:i,prefix});i+=prefix;}else i++;}
 if(!starts.length||data.subarray(0,starts[0]!.start).some(x=>x!==0))throw new H264InputError('H264 packet requires Annex-B access-unit framing');
 let hasVcl=false;const parameterSets:H264Sps[]=[],units:H264Nal[]=[];
 for(let i=0;i<starts.length;i++){const start=starts[i]!,end=starts[i+1]?.start??data.length,nal=data.subarray(start.start+start.prefix,end);if(nal.length<1||(nal[0]!&128)!==0)throw new H264InputError('Invalid H264 NAL header');const type=nal[0]!&31;const sps=type===7?inspectH264Sps(nal,maxFrameBytes):undefined;if(sps)parameterSets.push(sps);units.push(Object.freeze({data:nal,type,...(sps?{sps}:{})}));if(type>=1&&type<=5)hasVcl=true;if(type===15||type===20)throw new H264InputError('H264 extension access units are not connected yet');}
 return Object.freeze({hasVcl,parameterSets:Object.freeze(parameterSets),units:Object.freeze(units)});
}
