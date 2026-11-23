import {it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Track {index:number;type:string;codecTag:string;width:number;height:number;sampleRate?:number;initialPadding?:string;duration:string;sampleCount:string;timeBase:{num:string;den:string}}
interface Packet {streamIndex:number;data:string;pts:string;dts:string;duration:string;position:string;flags:number;skipSamples?:{skipSamples:string;discardPadding:string}}
it('compares 85 native MP4 fixtures through staged public R2',async()=>{
 const bundle=await build({entryPoints:['tests/workers/mp4-demux-fixture.ts'],tsconfig:'tsconfig.json',bundle:true,metafile:true,write:false,format:'esm',platform:'browser'});
 expect(Object.keys(bundle.metafile.inputs).filter(p=>p.startsWith('.build/'))).toEqual([]);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));
 const canonical=new URL('../../compat/behavior-specs/mp4-demux/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',canonical),'utf8')) as {sha256:Record<string,string>};for(const[name,digest]of Object.entries(manifest.sha256))expect(createHash('sha256').update(readFileSync(new URL(name,canonical))).digest('hex'),name).toBe(digest);
 const rows=JSON.parse(readFileSync(new URL('inputs.json',canonical),'utf8')) as {id:string;input:string}[];
 const results=JSON.parse(readFileSync(new URL('results.json',canonical),'utf8'));
 const evidence:{file:string;tracks:number;packets:number}[]=[];
 try{
  await mf.ready;expect(rows).toHaveLength(85);
  for(const row of rows){
   const expected=results.find((r:{id:string})=>r.id===row.id);expect(expected).toBeDefined();const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(Buffer.from(row.input,'base64'))})});expect(response.status,row.id).toBe(200);
   const actual=await response.json() as {info:{tracks:Track[]};packets:Packet[];reads:{offset:string;length:number}[]};
   expect(actual.info.tracks,row.id).toHaveLength(expected.streams.length);
   expect(actual.packets.map(p=>[p.streamIndex,p.position]),row.id).toEqual(expected.packets.map((p:{stream_index:number;pos:string})=>[p.stream_index,p.pos]));
   for(const track of actual.info.tracks){const stream=expected.streams[track.index];
    expect(track.type,row.id).toBe(stream.codec_type);expect(track.codecTag,row.id).toBe(stream.codec_tag_string);
    expect(`${track.timeBase.num}/${track.timeBase.den}`,row.id).toBe(stream.time_base);
    if(track.type==='video'){expect(track.width).toBe(stream.width);expect(track.height).toBe(stream.height);}else expect(track.sampleRate).toBe(Number(stream.sample_rate));
    expect(track.duration,row.id).toBe(String(stream.duration_ts));expect(track.sampleCount,row.id).toBe(stream.nb_frames);
    if(stream.initial_padding)expect(track.initialPadding,row.id).toBe(String(stream.initial_padding));
    const wanted=expected.packets.filter((p:{stream_index:number})=>p.stream_index===track.index),packets=actual.packets.filter(p=>p.streamIndex===track.index);expect(packets,row.id).toHaveLength(wanted.length);
    for(const [i,p] of packets.entries()){const q=wanted[i];expect([p.pts,p.dts,p.duration,p.position,p.flags],row.id).toEqual([String(q.pts),String(q.dts),String(q.duration),q.pos,(q.flags.includes('K')?1:0)|(q.flags.includes('D')?4:0)]);
     const skip=q.side_data_list?.find((s:{side_data_type:string})=>s.side_data_type==='Skip Samples');if(skip)expect(p.skipSamples,row.id).toEqual({skipSamples:String(skip.skip_samples),discardPadding:String(skip.discard_padding)});else expect(p.skipSamples,row.id).toBeUndefined();
     expect(p.data,row.id).toBe(q.data);
    }
   }
   expect(actual.reads.every(r=>r.length<=17)).toBe(true);evidence.push({file:row.id,tracks:actual.info.tracks.length,packets:actual.packets.length});
  }
  writeFileSync('.build/mp4-demux-worker-results.json',JSON.stringify({jobs:rows.length,passed:true,evidence},null,2)+'\n');
 }finally{await mf.dispose();}
},60000);
