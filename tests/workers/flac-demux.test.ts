import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Packet {kind:'picture'|'audio';size:number;sha256:string}
interface Row {id:string;input:string;sha256:string;explode:boolean;status:number;expected:{tags?:Record<string,string>;chapters?:{id:number;start:string;end:string;tags:Record<string,string>}[];layout?:string;pictures?:{codec:string;tags:Record<string,string>}[];packets?:Packet[]}}
interface Metadata {tags:Record<string,string>;chapters:{id:number;start:string;end:string;tags:Record<string,string>}[];channelLayout:{name:string}|null}
interface PacketMeta {kind:Packet['kind'];descriptor?:{codec:string;tags:Record<string,string>};pts?:string|null;dts?:string|null;duration?:string|null;range?:{sourceOffset:string}}
async function decode(response:Awaited<ReturnType<Miniflare['dispatchFetch']>>){
 if(!response.body)throw Error('Missing body');const reader=response.body.getReader();let pending:Buffer=Buffer.alloc(0),current:{meta:PacketMeta;hash:ReturnType<typeof createHash>;size:number}|null=null,metadata:Metadata|undefined;
 const packets:Packet[]=[],pictures:{codec:string;tags:Record<string,string>}[]=[],audioTiming:{pts:string|null;dts:string|null;duration:string|null;sourceOffset:string|null}[]=[];
 try{for(;;){const next=await reader.read();if(next.done)break;if(!(next.value instanceof Uint8Array))throw Error('Invalid body chunk');pending=Buffer.concat([pending,next.value]);while(pending.length>=5){const kind=pending[0]!,length=pending.readUInt32BE(1);if(length>65536)throw Error('Frame bound');if(pending.length<length+5)break;const bytes=pending.subarray(5,length+5);pending=pending.subarray(length+5);
  if(kind===5){expect(metadata).toBeUndefined();metadata=JSON.parse(bytes.toString()) as Metadata;}
  else if(kind===0){expect(current).toBeNull();const meta=JSON.parse(bytes.toString()) as PacketMeta;current={meta,hash:createHash('sha256'),size:0};if(meta.kind==='audio')audioTiming.push({pts:meta.pts??null,dts:meta.dts??null,duration:meta.duration??null,sourceOffset:meta.range?.sourceOffset??null});if(meta.kind==='picture'){if(!meta.descriptor)throw Error('Missing picture descriptor');pictures.push({codec:meta.descriptor.codec,tags:meta.descriptor.tags});}}
  else if(kind===1){if(!current)throw Error('Missing packet');current.hash.update(bytes);current.size+=bytes.length;}
  else if(kind===2){if(!current)throw Error('Missing packet end');packets.push({kind:current.meta.kind,size:current.size,sha256:current.hash.digest('hex')});current=null;}
  else if(kind===4)throw Error((JSON.parse(bytes.toString()) as {error:string}).error);else throw Error('Unknown frame');
 }}expect(pending.length).toBe(0);expect(current).toBeNull();if(!metadata)throw Error('Missing metadata');return{metadata,pictures,packets,audioTiming};}finally{reader.releaseLock();}
}
it('matches 132 finite Native FLAC metadata and picture cases through public demux on actual workerd/R2',async()=>{
 const base=new URL('../../compat/behavior-specs/flac-demux-workers/',import.meta.url),raw=readFileSync(new URL('cases.json',base)),manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8')) as {casesSha256:string},sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');expect(sha(raw)).toBe(manifest.casesSha256);
 const corpus=JSON.parse(raw.toString()) as {rows:Row[]};expect(corpus.rows).toHaveLength(132);
 const bundle=await build({entryPoints:['tests/workers/flac-demux-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports).toEqual([]);for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const ids:string[]=[],failures:unknown[]=[];
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');for(const row of corpus.rows){ids.push(row.id);try{
  const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.sha256);await bucket.put('source/input.flac',input);
  const response=await mf.dispatchFetch('https://demux.test/?id='+row.id+'&explode='+(row.explode?'1':'0'));
  if(row.status!==0){expect(response.status).toBe(422);expect((await response.json() as {owned:number}).owned).toBe(0);}
  else {expect(response.status).toBe(200);const actual=await decode(response);if(row.expected.tags)expect(actual.metadata.tags,row.id).toEqual(row.expected.tags);if(row.expected.chapters)expect(actual.metadata.chapters.map(({id,start,end,tags})=>({id,start,end,tags})),row.id).toEqual(row.expected.chapters);if(row.expected.layout)expect(actual.metadata.channelLayout?.name,row.id).toBe(row.expected.layout);if(row.expected.pictures)expect(actual.pictures,row.id).toEqual(row.expected.pictures);if(row.expected.packets)expect(actual.packets,row.id).toEqual(row.expected.packets);}
  const object=await bucket.get('metrics/'+row.id);expect(object).not.toBeNull();const metrics=JSON.parse(await object!.text()) as {owned:number;peak:number;maximumRead:number;closed:boolean};expect(metrics.owned).toBe(0);expect(metrics.peak).toBeLessThanOrEqual(65570);expect(metrics.maximumRead).toBeLessThanOrEqual(65536);expect(metrics.closed).toBe(true);
 }catch(error){failures.push({id:row.id,error:String(error)});}}
 expect(failures).toEqual([]);
 }finally{if(bucket){for(const id of ids)await bucket.delete('metrics/'+id);await bucket.delete('source/input.flac');expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},60000);

it('matches pinned Native 16MiB picture continuation under four policies and releases on consumer cancellation in workerd/R2',async()=>{
 const raw=readFileSync(new URL('../../compat/behavior-specs/flac-demux-workers/large.json',import.meta.url),'utf8');
 const manifest=JSON.parse(readFileSync(new URL('../../compat/behavior-specs/flac-demux-workers/manifest.json',import.meta.url),'utf8')) as {largeSha256:string};expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.largeSha256);
 const fixture=JSON.parse(raw) as {recipe:{prefix:string;zeroBytes:number;suffix:string;sha256:string;bytes:number};native:{rows:{id:string;status:number;parsed:{packets?:{stream_index:number;size:string;data_hash:string;pts?:number;dts?:number;duration?:number;pos?:string}[];streams?:{index:number;codec_type:string}[]}}[]}};
 const recipe=fixture.recipe,input=Buffer.concat([Buffer.from(recipe.prefix,'base64'),Buffer.alloc(recipe.zeroBytes),Buffer.from(recipe.suffix,'base64')]);expect(input.length).toBe(recipe.bytes);expect(createHash('sha256').update(input).digest('hex')).toBe(recipe.sha256);
 const bundle=await build({entryPoints:['tests/workers/flac-demux-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const ids:string[]=[];
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/input.flac',input);
  for(const row of fixture.native.rows){const id='large-'+row.id;ids.push(id);const response=await mf.dispatchFetch('https://demux.test/?id='+id+'&explode='+(row.id.includes('explode')?'1':'0')+'&strict='+(row.id.includes('strict')?'1':'0'));
   if(row.status!==0){expect(response.status).toBe(422);expect((await response.json() as {owned:number}).owned).toBe(0);}
   else{expect(response.status).toBe(200);const actual=await decode(response),refs=row.parsed.packets??[],pictures=new Set(row.parsed.streams?.filter(s=>s.codec_type==='video').map(s=>s.index));
    expect(actual.packets).toEqual(refs.map(p=>({kind:pictures.has(p.stream_index)?'picture':'audio',size:Number(p.size),sha256:p.data_hash.replace('SHA256:','')})));
    expect(actual.audioTiming).toEqual(refs.filter(p=>!pictures.has(p.stream_index)).map(p=>({pts:p.pts===undefined?null:String(p.pts),dts:p.dts===undefined?null:String(p.dts),duration:p.duration===undefined?null:String(p.duration),sourceOffset:p.pos??null})));
   }
   const object=await bucket.get('metrics/'+id);if(!object)throw Error('Missing metrics');const metrics=JSON.parse(await object.text()) as {owned:number;peak:number;closed:boolean};expect(metrics.owned).toBe(0);expect(metrics.peak).toBeLessThanOrEqual(65570);expect(metrics.closed).toBe(true);
  }
  const id='large-consumer-cancel';ids.push(id);const response=await mf.dispatchFetch('https://demux.test/?id='+id);expect(response.status).toBe(200);if(!response.body)throw Error('Missing body');const reader=response.body.getReader();expect((await reader.read()).done).toBe(false);expect((await reader.read()).done).toBe(false);await reader.cancel('consumer');reader.releaseLock();
  const deadline=Date.now()+5000;let object=await bucket.get('metrics/'+id);while(!object){if(Date.now()>=deadline)throw Error('Cancel cleanup exceeded5000ms');await new Promise(resolve=>setTimeout(resolve,10));object=await bucket.get('metrics/'+id);}const metrics=JSON.parse(await object.text()) as {owned:number;closed:boolean};expect(metrics.owned).toBe(0);expect(metrics.closed).toBe(true);
 }finally{if(bucket){for(const id of ids)await bucket.delete('metrics/'+id);await bucket.delete('source/input.flac');expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},60000);
