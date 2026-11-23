import {it,expect} from 'vitest';
import {ExecutionError} from '@edge-ffmpeg/core';
import {snapshotFlacSelection,selectFlacStreams} from '../../packages/avformat/src/flac-selection.js';
import evidence from '../../compat/behavior-specs/flac-selection/cases.json' with {type:'json'};
const defaults={audio:true,picture:'first' as const};
const identities={audioStreamId:0,pictureStreamIds:[1,2]};
function select(maps:readonly string[],options:{audio?:boolean;video?:boolean;picture?:'first'|'none'}={}){
 return selectFlacStreams(snapshotFlacSelection({maps,audio:options.audio??true,video:options.video??true,defaults:{audio:true,picture:options.picture??'first'}}),identities);
}
for(const [index,row] of evidence.rows.entries())it(`Native144 row ${index}: ${row.kind} ${row.maps.join(',')} audio=${row.audio} video=${row.video}`,()=>{
 const policy=snapshotFlacSelection({maps:row.maps,audio:row.audio,video:row.video,defaults});
 const run=()=>selectFlacStreams(policy,{audioStreamId:0,pictureStreamIds:row.kind==='pictured'?[1]:[]});
 if(row.exitCode===0)expect(run().streamIds).toEqual(row.selected);
 else expect(run).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:row.exitCode}));
});
it('retains exact picture identities, map order and picture/audio duplicates',()=>{
 const result=select(['0:2','0:a','0:v:0','0:2','0:a']);
 expect(result.streamIds).toEqual([2,0,1,2,0]);expect(result.pictureStreamIds).toEqual([2,1,2]);expect(result.audioStreamIds).toEqual([0,0]);expect(result.automatic).toBe(false);
 expect(select(['0:2','0:2','0:a','-0:v:1','0:2']).streamIds).toEqual([0,2]);
 expect(select(['0:a','0:a','-0:a','0:2']).streamIds).toEqual([2]);
});
it('uses type-relative picture indexes but absolute demux stream IDs',()=>{
 const policy=snapshotFlacSelection({maps:['0:v:1','0:5','0:a'],audio:true,video:true,defaults});
 expect(selectFlacStreams(policy,{audioStreamId:0,pictureStreamIds:[3,5]}).streamIds).toEqual([5,5,0]);
});
it('makes defaults output policy, never silently drops explicitly selected pictures',()=>{
 expect(select([]).streamIds).toEqual([1,0]);expect(select([],{picture:'none'}).streamIds).toEqual([0]);
 expect(select(['0:v'],{picture:'none'}).streamIds).toEqual([1,2]);
 expect(select(['0:v:20?'],{picture:'none'}).streamIds).toEqual([0]);
 expect(select(['0'],{video:false}).streamIds).toEqual([0]);
 expect(select(['0'],{audio:false}).streamIds).toEqual([1,2]);
 expect(select(['0:v','-0:v','-0:a?','0:a']).streamIds).toEqual([0]);
 expect(()=>select(['0','-0'])).toThrow(/no selected streams/);
 expect(()=>select(['0:v'],{video:false})).toThrow(/no selected streams/);
});
it('snapshots policy primitives, map strings and defaults before any await',async()=>{
 const options={maps:['0:2'],audio:true,video:true,defaults:{audio:true,picture:'first' as 'first'|'none'}};
 const policy=snapshotFlacSelection(options);
 await Promise.resolve();options.maps[0]='0:a';options.maps.push('-0:v');options.video=false;options.defaults.picture='none';
 const result=selectFlacStreams(policy,identities);expect(result.streamIds).toEqual([2]);
 expect(Object.isFrozen(policy)).toBe(true);expect(Object.isFrozen(policy.maps)).toBe(true);expect(Object.isFrozen(policy.maps[0])).toBe(true);expect(Object.isFrozen(policy.defaults)).toBe(true);
 expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.streamIds)).toBe(true);
 expect(Object.keys(result).sort()).toEqual(['audioStreamIds','automatic','pictureStreamIds','streamIds']);
});
for(const map of ['',':','0:','0:a:','0:v:-1','0:garbage','0:a??','1:a?','-1:a?','0:9007199254740992'])it(`distinguishes invalid map ${JSON.stringify(map)}`,()=>{
 expect(()=>select([map])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
});
for(const map of ['[out]','0:m:language:eng','0:p:1','0:s'])it(`discloses unsupported specifier ${map}`,()=>{
 expect(()=>select([map])).toThrow(expect.objectContaining({code:'unsupported-command',exitCode:1}));
});
it('selects intrinsic attached pictures and excludes them from uppercase V',()=>{
 expect(select(['0:disp:attached_pic']).streamIds).toEqual([1,2]);
 expect(()=>select(['0:V'])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
 expect(select(['0:V?']).streamIds).toEqual([1,0]);
});
it('bounds maps, input streams and selected duplicates to 64 before expansion',()=>{
 expect(select(Array.from({length:64},()=> '0:a')).streamIds).toHaveLength(64);
 expect(()=>select(Array.from({length:65},()=> '0:a'))).toThrow(/map limit/);
 expect(()=>select(Array.from({length:22},()=> '0'))).toThrow(/selected stream limit/);
 const policy=snapshotFlacSelection({maps:['0'],audio:true,video:true,defaults});
 expect(selectFlacStreams(policy,{audioStreamId:0,pictureStreamIds:Array.from({length:63},(_,i)=>i+1)}).streamIds).toHaveLength(64);
 expect(()=>selectFlacStreams(policy,{audioStreamId:0,pictureStreamIds:Array.from({length:64},(_,i)=>i+1)})).toThrow(/limit/);
 expect(()=>select(['0'.repeat(129)] )).toThrow(/length limit/);
});
it('rejects malformed identities instead of aliasing distinct pictures',()=>{
 for(const ids of [[1,1],[2,1],[0],[1.5],[Number.NaN]])expect(()=>selectFlacStreams(snapshotFlacSelection({maps:[],audio:true,video:true,defaults}),{audioStreamId:0,pictureStreamIds:ids})).toThrow(ExecutionError);
});
