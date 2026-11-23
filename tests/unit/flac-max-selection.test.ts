import {it,expect} from 'vitest';
import {snapshotFlacSelection,selectFlacStreams} from '../../packages/avformat/src/flac-selection.js';
import type {FlacStreamIdentities} from '../../packages/avformat/src/flac-selection.js';
import legacy from '../../compat/behavior-specs/flac-selection/cases.json' with {type:'json'};
import advanced from '../../compat/behavior-specs/flac-max-selection/cases.json' with {type:'json'};

const identities:FlacStreamIdentities=Object.freeze({audioStreamId:0,pictureStreamIds:Object.freeze([2,5])});
function select(maps:readonly string[],streams:FlacStreamIdentities=identities,options:{audio?:boolean;video?:boolean;picture?:'first'|'none'}={}){
 return selectFlacStreams(snapshotFlacSelection({maps,audio:options.audio??true,video:options.video??true,defaults:{audio:true,picture:options.picture??'first'}}),streams);
}

it('preserves every independently observed Native144 legacy outcome',()=>{
 expect(legacy.rows).toHaveLength(144);
 for(const row of legacy.rows){
  const run=()=>select(row.maps,{audioStreamId:0,pictureStreamIds:row.kind==='pictured'?[1]:[]},{audio:row.audio,video:row.video});
  if(row.exitCode===0)expect(run().streamIds,JSON.stringify(row.maps)).toEqual(row.selected);
  else expect(run,JSON.stringify(row.maps)).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:row.exitCode}));
 }
});

it('V excludes every FLAC attached picture, including sparse absolute stream identities',()=>{
 expect(()=>select(['0:V'])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
 expect(select(['0:V?']).streamIds).toEqual([2,0]);
 expect(select(['0:V?'],identities,{picture:'none'}).streamIds).toEqual([0]);
 expect(select(['0:a','-0:V']).streamIds).toEqual([0]);
 expect(select(['0:v','-0:V']).streamIds).toEqual([2,5]);
});

it('unmatched V optional maps cannot erase explicit picture selection or revive automatic selection',()=>{
 expect(select(['0:5','0:V?','0:5','-0:V']).streamIds).toEqual([5,5]);
 expect(select(['0:a','0:V?','0:2']).streamIds).toEqual([0,2]);
 expect(()=>select(['0:v','-0:v','0:V?'])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
 expect(()=>select(['-0:V','0:a'])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
});

it('keeps duplicate removals ordered and output switches later than matching',()=>{
 expect(select(['0:5','0:5','0:a','-0:v:1','0:5']).streamIds).toEqual([0,5]);
 expect(select(['0:v','0:a','-0:a','0:a'],identities,{video:false}).streamIds).toEqual([0]);
 expect(()=>select(['0:v'],identities,{video:false})).toThrow(/no selected streams/);
 expect(select(['0:v'],identities,{picture:'none'}).pictureStreamIds).toEqual([2,5]);
});

it('snapshots every command primitive and freezes the selected ID projections',async()=>{
 const options={maps:['0:5','0:a'],audio:true,video:true,defaults:{audio:true,picture:'first' as 'first'|'none'}};
 const policy=snapshotFlacSelection(options);
 await Promise.resolve();
 options.maps.splice(0,2,'0:2');options.audio=false;options.video=false;options.defaults.audio=false;options.defaults.picture='none';
 const selected=selectFlacStreams(policy,identities);
 expect(selected.streamIds).toEqual([5,0]);expect(selected.pictureStreamIds).toEqual([5]);expect(selected.audioStreamIds).toEqual([0]);
 for(const value of [policy,policy.maps,...policy.maps,policy.defaults,selected,selected.streamIds,selected.audioStreamIds,selected.pictureStreamIds])expect(Object.isFrozen(value)).toBe(true);
 expect(Object.keys(selected).sort()).toEqual(['audioStreamIds','automatic','pictureStreamIds','streamIds']);
});

it('bounds map snapshots, input identities and duplicate expansion at exactly 64',()=>{
 expect(select(Array.from({length:64},()=> '0:a')).streamIds).toHaveLength(64);
 expect(()=>select(Array.from({length:65},()=> '0:a'))).toThrow(expect.objectContaining({code:'unsupported-command'}));
 const maximum={audioStreamId:0,pictureStreamIds:Array.from({length:63},(_,index)=>index+1)};
 expect(select(['0'],maximum).streamIds).toHaveLength(64);
 expect(()=>select(['0','0:a'],maximum)).toThrow(/selected stream limit/);
 expect(()=>select(['0'],{audioStreamId:0,pictureStreamIds:Array.from({length:64},(_,index)=>index+1)})).toThrow(/limit/);
 expect(()=>select(['0:'.padEnd(129,'a')])).toThrow(/length limit/);
});

it('does not broaden unsupported specifiers when the optional suffix is present',()=>{
 for(const map of ['[out]','0:p:1','0:g:1','0:i:1','0:s','0:t','0:d']){
  expect(()=>select([map+'?'])).toThrow(expect.objectContaining({code:'unsupported-command'}));
 }
 for(const map of ['1:V?','0:a:','0:v:-1','0:garbage?','0:9007199254740992']){
  expect(()=>select([map])).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:234}));
 }
});

it('rejects malformed identities rather than aliasing a selected picture to audio',()=>{
 for(const pictureStreamIds of [[0],[2,2],[5,2],[-1],[1.5],[NaN],[Infinity]]){
  expect(()=>select(['0'],{audioStreamId:0,pictureStreamIds})).toThrow(expect.objectContaining({code:'invalid-arguments'}));
 }
 expect(()=>select(['0'],{audioStreamId:1,pictureStreamIds:[2]})).toThrow(expect.objectContaining({code:'invalid-arguments'}));
});

it('matches all 60 saved advanced Native selections using stream facts, not container tags',()=>{
 expect(advanced.reference.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');
 expect(advanced.rows).toHaveLength(60);
 for(const row of advanced.rows){
  const streams:FlacStreamIdentities={audioStreamId:0,pictureStreamIds:row.descriptors.filter(value=>value.attachedPicture).map(value=>value.streamId),streamDescriptors:row.descriptors.map(value=>({streamId:value.streamId,tags:value.metadata as Record<string,string>,dispositions:value.attachedPicture?['attached_pic']:[]}))};
  const run=()=>select(row.maps,streams);
  if(row.exitCode===0)expect(run().streamIds,row.id).toEqual(row.selectedStreamIds);
  else expect(run,row.id).toThrow(expect.objectContaining({code:'invalid-arguments',exitCode:row.exitCode}));
 }
});

it('treats metadata question marks literally and keys ASCII-insensitively but values exactly',()=>{
 const streams:FlacStreamIdentities={...identities,streamDescriptors:[{streamId:0},{streamId:2,tags:{TITLE:'cover','title?':'literal',question:'cover?',Title:'shadow'}},{streamId:5,tags:{title:'Cover'}}]};
 expect(select(['0:m:TiTlE:cover'],streams).streamIds).toEqual([2]);
 expect(select(['0:v:m:title:Cover'],streams).streamIds).toEqual([5]);
 expect(select(['0:m:title?'],streams).streamIds).toEqual([2]);
 expect(select(['0:m:question:cover?'],streams).streamIds).toEqual([2]);
 expect(()=>select(['0:m:title:shadow'],streams)).toThrow(expect.objectContaining({code:'invalid-arguments'}));
 expect(()=>select(['0:m:missing?'],streams)).toThrow(expect.objectContaining({code:'invalid-arguments'}));
 expect(()=>select(['0:a:m:title:cover'],streams)).toThrow(expect.objectContaining({code:'invalid-arguments'}));
});

it('requires actual usable facts even for optional maps and never infers them from identity',()=>{
 const streams:FlacStreamIdentities={...identities,streamDescriptors:[{streamId:0,usable:true},{streamId:2,usable:false},{streamId:5,usable:true}]};
 expect(select(['0:u'],streams).streamIds).toEqual([0,5]);
 expect(select(['0:a:u'],streams).streamIds).toEqual([0]);
 expect(select(['0:v:u'],streams).streamIds).toEqual([5]);
 expect(select(['0:V:u?'],streams).streamIds).toEqual([2,0]);
 for(const map of ['0:m:title?','0:u?','0:v:u?'])expect(()=>select([map])).toThrow(expect.objectContaining({code:'unsupported-command'}));
 expect(select(['0:disp:attached_pic']).streamIds).toEqual([2,5]);
 expect(()=>select(['0:disp:default?'],streams)).toThrow(expect.objectContaining({code:'unsupported-command'}));
});

it('bounds descriptor dictionaries, tag characters and dispositions without counting inherited tags',()=>{
 const tagged=(tags:Record<string,string>):FlacStreamIdentities=>({audioStreamId:0,pictureStreamIds:[],streamDescriptors:[{streamId:0,tags}]});
 const tags=Object.fromEntries(Array.from({length:1024},(_,index)=>['k'+index,'v']));
 expect(select(['0:a'],tagged(tags)).streamIds).toEqual([0]);
 expect(()=>select(['0:a'],tagged({...tags,extra:'v'}))).toThrow(expect.objectContaining({code:'unsupported-command'}));
 expect(select(['0:m:k'],tagged({k:'v'.repeat(65535)})).streamIds).toEqual([0]);
 expect(()=>select(['0:a'],tagged({k:'v'.repeat(65536)}))).toThrow(expect.objectContaining({code:'unsupported-command'}));
 const inherited=Object.create({title:'not an own tag'}) as Record<string,string>;
 expect(()=>select(['0:m:title'],tagged(inherited))).toThrow(expect.objectContaining({code:'invalid-arguments'}));
 for(const streamDescriptors of [[{streamId:9}],[{streamId:0},{streamId:0}],[{streamId:0,dispositions:['attached_pic']}]])expect(()=>select(['0:a'],{...identities,streamDescriptors})).toThrow(expect.objectContaining({code:'invalid-arguments'}));
 expect(()=>select(['0:a'],{...identities,streamDescriptors:[{streamId:0,dispositions:Array.from({length:65},()=> 'default')}]})).toThrow(expect.objectContaining({code:'unsupported-command'}));
});
