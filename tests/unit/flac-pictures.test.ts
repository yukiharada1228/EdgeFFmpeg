import {test} from 'vitest';import assert from 'node:assert/strict';import {decodeReferenceBase64Into,parseFlacPicturePayload,FlacPictureLimitError} from '../../packages/containers/src/flac/pictures.js';
import corpus from '../../compat/behavior-specs/flac-pictures/native-pictures.json' with {type:'json'};
function decodeDump(text:string,size:number){const parts=[];let offset=0;for(const line of text.split('\n')){if(!line.trim())continue;const match=/^([0-9a-f]{8}):/.exec(line);assert(match);assert.equal(parseInt(match[1]!,16),offset);const hex=line.slice(line.indexOf(':')+1).trimStart().split('  ')[0]!.replace(/\s/g,'');assert(/^(?:[0-9a-f]{2})+$/i.test(hex));const bytes=Buffer.from(hex,'hex');parts.push(bytes);offset+=bytes.length;}assert.equal(offset,size);return Buffer.concat(parts);}
test('54Native picture cases match block/comment failure policy and accepted attachment descriptors/bytes',()=>{
 let matched=0,accepted=0;for(const row of corpus.rows){let payload:Uint8Array=Buffer.from(row.payload,'base64'),result:ReturnType<typeof parseFlacPicturePayload>|undefined;if(row.transport==='comment'){const decoded=new Uint8Array(4096),length=decodeReferenceBase64Into(decoded,row.encoded!);if(length<0)result={kind:'ignored',fatal:false,reason:'base64',warnings:[]};else payload=decoded.subarray(0,length);}result??=parseFlacPicturePayload(payload,{transport:row.transport as 'block'|'comment',explode:row.policy==='explode'});assert.equal(result.fatal?1:0,row.native.status,row.id+'/'+row.transport+'/'+row.policy);assert.equal(result.kind==='accepted'?1:0,row.native.pictures.length,row.id);
  if(result.kind==='accepted'){const ref=row.native.pictures[0]!;assert.equal(result.codec,ref.codec_name);assert.equal(result.declaredWidth,ref.width);assert.equal(result.declaredHeight,ref.height);assert.deepEqual(result.tags,ref.tags);const packet=row.native.packets.find(p=>p.stream_index===ref.index);assert(packet);assert.deepEqual(Buffer.from(payload.subarray(result.dataOffset,result.dataOffset+result.dataBytes)),decodeDump(packet.data,Number(packet.size)));accepted++;}matched++;
 }assert.equal(matched,54);assert(accepted>0);
});
test('picture parser enforces payload/description/image budgets without allocating image bytes',()=>{
 const payload=Buffer.from(corpus.rows.find(r=>r.id==='bmp')!.payload,'base64');for(const limits of [{maxPayloadBytes:1},{maxDescriptionBytes:1},{maxPictureBytes:1}])assert.throws(()=>parseFlacPicturePayload(payload,limits),FlacPictureLimitError);
});
test('base64 source-defined terminal and capacity behavior is explicit',()=>{
 for(const [text,expected]of [['TQ==!','M'],['TQ','M'],['TWE','Ma'],['TWFu','Man'],['T\0anything','']] as const){const bytes=new Uint8Array(8),length=decodeReferenceBase64Into(bytes,text);assert.equal(new TextDecoder().decode(bytes.subarray(0,length)),expected);}assert.equal(decodeReferenceBase64Into(new Uint8Array(8),'TW Fu'),-1);assert.equal(decodeReferenceBase64Into(new Uint8Array(1),'TWFu'),1);
});
test('source-defined24bit truncation branch requests exact missing span without allocating it',()=>{
 const clean=Buffer.from(corpus.rows.find(r=>r.id==='bmp')!.payload,'base64'),decoded=parseFlacPicturePayload(clean);assert(decoded.kind==='accepted');const payload=Buffer.from(clean),length=16777216+decoded.dataBytes;payload.writeUInt32BE(length,decoded.dataOffset-4);
 const result=parseFlacPicturePayload(payload,{maxPictureBytes:length});assert(result.kind==='needs-truncation-read');assert.equal(result.dataOffset,decoded.dataOffset);assert.equal(result.dataBytes,length);assert.equal(result.additionalBytes,16777216);
 assert.equal(parseFlacPicturePayload(payload,{transport:'comment',maxPictureBytes:length}).kind,'ignored');assert.equal(parseFlacPicturePayload(payload,{strictCompliance:1,maxPictureBytes:length}).kind,'ignored');assert.throws(()=>parseFlacPicturePayload(payload),FlacPictureLimitError);
});
test('descriptor parsing leaves source bytes untouched despite Native description termination mutation',()=>{
 const bytes=Buffer.from(corpus.rows.find(r=>r.id==='bmp')!.payload,'base64'),before=Buffer.from(bytes);parseFlacPicturePayload(bytes);assert.deepEqual(bytes,before);
});

import {ResourceContext} from '../../packages/core/src/resources.js';
import {readFlacPictureRange} from '../../packages/containers/src/flac/picture-reader.js';
import {createReferenceBase64Source,Base64SourceLimitError} from '../../packages/containers/src/flac/base64-source.js';
import {createHash} from 'node:crypto';
function owned(signal=new AbortController().signal){return {signal,resources:new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:1},signal)};}
test('Native range and base64 sources preserve policies under short reads',async()=>{
 for(const row of corpus.rows)for(const cap of [1,7,34]){
  const opts=owned(),bytes=Buffer.from(row.payload,'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),row.payloadSha256);
  const source=row.transport==='comment'?createReferenceBase64Source(row.encoded!,{signal:opts.signal,maxReadBytes:cap}):{size:BigInt(bytes.length),async readAt(offset:bigint,length:number){return bytes.subarray(Number(offset),Number(offset)+Math.min(cap,length));}};
  if(!source){assert.equal(row.native.pictures.length,0);continue;}
  const result=await readFlacPictureRange(source,{...opts,payloadOffset:0n,payloadBytes:Number(source.size),maxReadBytes:cap,transport:row.transport as 'block'|'comment',explode:row.policy==='explode'});
  assert.equal(Number(result.descriptor.fatal),row.native.status);assert.equal(Number(result.descriptor.kind==='accepted'),row.native.pictures.length);
  assert.equal(opts.resources.allocatedBytes,0);assert.equal(result.metrics.ownedBufferBytes,0);assert(result.metrics.maximumRead<=cap);assert.equal(result.metrics.wholeImagePayloadBuffered,false);
 }
});
test('pending reads and checkpoints abort immediately and observe late rejection',async()=>{
 for(const checkpoint of [false,true]){
  const controller=new AbortController(),opts=owned(controller.signal),reason=new Error('cancel picture');
  let entered!:()=>void,rejectLate!:(e:unknown)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const pending=()=>{entered();return new Promise<Uint8Array>((_resolve,reject)=>{rejectLate=reject;});};
  const result=readFlacPictureRange({size:100n,readAt:pending},{...opts,payloadOffset:0n,payloadBytes:100,...(checkpoint?{checkpoint:async()=>{await pending();}}:{})});
  const rejected=assert.rejects(result,e=>e===reason);await started;controller.abort(reason);assert.equal(opts.resources.allocatedBytes,0);await rejected;rejectLate(new Error('late'));await Promise.resolve();
 }
});
test('base64 unaligned reads, terminal semantics, bounds and abort',async()=>{
 const signal=new AbortController().signal;
 for(let length=0;length<256;length++){
  const bytes=Uint8Array.from({length},(_,i)=>(i*37+length)&255),source=createReferenceBase64Source(Buffer.from(bytes).toString('base64').replace(/=+$/,''),{signal,maxReadBytes:17});assert(source);
  for(let offset=0;offset<=length;offset+=7)assert.deepEqual(await source.readAt(BigInt(offset),17),bytes.subarray(offset,Math.min(length,offset+17)));
 }
 assert.throws(()=>createReferenceBase64Source('TWFu',{signal,maxEncodedChars:1}),Base64SourceLimitError);assert.throws(()=>createReferenceBase64Source('TWFu',{signal,maxDecodedBytes:1}),Base64SourceLimitError);
 assert.equal(createReferenceBase64Source('TW Fu',{signal}),null);assert.equal(createReferenceBase64Source('TQ==ignored!',{signal})!.size,1n);
 const controller=new AbortController(),source=createReferenceBase64Source('TWFu',{signal:controller.signal})!;controller.abort('cancel');await assert.rejects(source.readAt(0n,3),e=>e==='cancel');assert.equal(source.metrics.generatedBytes,0n);
});
test('reader enforces field/image budgets and peeks at most eight image bytes',async()=>{
 const bytes=Buffer.from(corpus.rows.find(r=>r.id==='bmp')!.payload,'base64'),opts=owned();
 const source={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){return bytes.subarray(Number(offset),Number(offset)+length);}};
 for(const limits of [{maxPayloadBytes:1},{maxDescriptionBytes:1},{maxPictureBytes:1}]){
  await assert.rejects(readFlacPictureRange(source,{...opts,...limits,payloadOffset:0n,payloadBytes:bytes.length}),FlacPictureLimitError);assert.equal(opts.resources.allocatedBytes,0);
 }
 const result=await readFlacPictureRange(source,{...opts,payloadOffset:0n,payloadBytes:bytes.length});assert(result.descriptor.kind==='accepted');assert.equal(result.metrics.bytesRead,BigInt(result.descriptor.dataOffset+8));assert.equal(result.dataRange!.bytes,BigInt(result.descriptor.dataBytes));
 const controller=new AbortController(),cancelled=owned(controller.signal);controller.abort('already');await assert.rejects(readFlacPictureRange(source,{...cancelled,payloadOffset:0n,payloadBytes:bytes.length}),e=>e==='already');assert.equal(cancelled.resources.allocatedBytes,0);
});
