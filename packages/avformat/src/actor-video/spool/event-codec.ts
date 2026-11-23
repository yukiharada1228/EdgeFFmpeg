import {validateTimedEvent} from './validate-event.js';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
/** Same-execution codec. Error references deliberately cannot survive isolate restart. */
export function createTimedEventCodec(limits:{maxRecordBytes:number;maxNodes:number;maxErrors:number}){
 const bounds={...limits};for(const n of Object.values(bounds))if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid event codec bounds');
 const errors:unknown[]=[];let closed=false;const check=()=>{if(closed)throw new Error('Event codec released');};
 const reference=(value:unknown)=>{let index=errors.findIndex(item=>Object.is(item,value));if(index<0){if(errors.length>=bounds.maxErrors)throw new Error('Event error registry budget exceeded');index=errors.length;errors.push(value);}return index;};
 return {
 encode(event:TimedVideoOutputEvent):Uint8Array{check();const savedErrors=errors.length;try{let nodes=0,payload=0,textBytes=0;const parts:Uint8Array[]=[],seen=new Set<object>();
  const text=(value:string)=>{textBytes+=value.length*6;if(textBytes>bounds.maxRecordBytes)throw new Error('Event text budget exceeded');return value;};
  const visit=(value:unknown,depth:number):unknown=>{if(++nodes>bounds.maxNodes||depth>32)throw new Error('Event metadata budget exceeded');
   if(value===null||typeof value==='boolean')return value;
   if(typeof value==='string'){if(value.length>bounds.maxRecordBytes)throw new Error('Event string budget exceeded');return ['s',text(value)];}
   if(typeof value==='bigint')return ['i',text(String(value))];
   if(typeof value==='number')return ['n',Object.is(value,-0)?'-0':String(value)];
   if(value===undefined)return ['u'];
   if(typeof value!=='object'||seen.has(value))throw new Error('Unsupported or cyclic event metadata');
   if(value instanceof Uint8Array){payload+=value.byteLength;if(payload>bounds.maxRecordBytes)throw new Error('Event payload budget exceeded');const index=parts.length;parts.push(value);return ['b',index,value.byteLength];}
   seen.add(value);try{if(Array.isArray(value))return ['a',value.map(item=>visit(item,depth+1))];
    const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new Error('Unsupported event metadata prototype');
    const pairs=[];for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')throw new Error('Unsupported event metadata key');const d=Object.getOwnPropertyDescriptor(value,key)!;if(!d.enumerable)continue;if(!('value'in d))throw new Error('Event metadata accessors are unsupported');pairs.push([text(key),visit(d.value,depth+1)]);}return ['o',pairs];
   }finally{seen.delete(value);}
  };
  let value:unknown=event;if(event.kind==='end'){value={...event,...('error'in event?{error:{reference:reference(event.error)}}:{}),secondaryErrors:event.secondaryErrors.map(error=>({reference:reference(error)}))};}
  const tree=visit(value,0),header=new TextEncoder().encode(JSON.stringify({version:1,tree}));if(header.length+payload+4>bounds.maxRecordBytes)throw new Error('Event record budget exceeded');
  const bytes=new Uint8Array(4+header.length+payload);new DataView(bytes.buffer).setUint32(0,header.length);bytes.set(header,4);let offset=4+header.length;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
 }catch(error){errors.length=savedErrors;throw error;}},
 decode(bytes:Uint8Array):TimedVideoOutputEvent{check();if(bytes.length<4||bytes.length>bounds.maxRecordBytes)throw new Error('Invalid event record size');const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);if(length>bytes.length-4)throw new Error('Invalid event header');const header=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(4,4+length)));if(!header||typeof header!=='object'||Array.isArray(header)||Object.keys(header).length!==2||!Object.hasOwn(header,'tree')||header.version!==1)throw new Error('Unsupported event record version');let nodes=0,offset=4+length,part=0;
  const visit=(value:unknown,depth:number):unknown=>{if(++nodes>bounds.maxNodes||depth>32)throw new Error('Event decode budget exceeded');if(value===null||typeof value==='boolean')return value;if(!Array.isArray(value)||value.length!==(value[0]==='u'?1:value[0]==='b'?3:2))throw new Error('Invalid event tree');switch(value[0]){
   case 's':if(typeof value[1]!=='string')break;return value[1];
   case 'i':if(typeof value[1]!=='string'||!/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value[1]))break;return BigInt(value[1]);
   case 'n':if(typeof value[1]!=='string'||!['NaN','Infinity','-Infinity','-0'].includes(value[1])&&(!Number.isFinite(Number(value[1]))||String(Number(value[1]))!==value[1]))break;return Number(value[1]);
   case 'u':return undefined;
   case 'b':{const size=value[2];if(value[1]!==part++||typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>bytes.length-offset)break;const result=bytes.slice(offset,offset+size);offset+=size;return result;}
   case 'a':if(!Array.isArray(value[1]))break;return value[1].map((item:unknown)=>visit(item,depth+1));
   case 'o':{if(!Array.isArray(value[1]))break;const result:Record<string,unknown>={};for(const pair of value[1]){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||Object.hasOwn(result,pair[0]))throw new Error('Invalid event object');Object.defineProperty(result,pair[0],{value:visit(pair[1],depth+1),enumerable:true,writable:true,configurable:true});}return result;}
  }throw new Error('Invalid event tag');};
  const value=visit(header.tree,0);if(offset!==bytes.length||!value||typeof value!=='object'||Array.isArray(value)||!('kind' in value)||!['frame','end'].includes(String(value.kind)))throw new Error('Invalid event envelope');
  const envelope=value as Record<string,unknown>;if(envelope.kind==='end'){const restore=(value:unknown)=>{const ref=value as Record<string,unknown>|null;if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==1||!Object.hasOwn(ref,'reference')||typeof ref.reference!=='number'||!Number.isSafeInteger(ref.reference)||ref.reference<0||ref.reference>=errors.length)throw new Error('Unknown event error reference');return errors[ref.reference];};if(Object.hasOwn(envelope,'error'))envelope.error=restore(envelope.error);if(!Array.isArray(envelope.secondaryErrors))throw new Error('Invalid event secondary errors');envelope.secondaryErrors=envelope.secondaryErrors.map(restore);}
  validateTimedEvent(value);return value;
 },
 close(){closed=true;errors.length=0;}
 };
}
