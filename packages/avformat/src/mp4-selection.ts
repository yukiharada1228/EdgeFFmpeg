// SPDX-License-Identifier: LGPL-2.1-or-later
// Selection semantics follow pinned fftools/ffmpeg_mux_init.c; see NOTICE-MP4-COPY.
import {languageSelector} from './mp4-language-selector.js';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {Mp4TrackInfo} from '@edge-ffmpeg/containers';
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
const streamIdPattern=/^(?:([va]):)?(?:i:|#)([\t\n\v\f\r ]*[+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*))(?![\s\S])/;
function streamId(selector:string):{type:string|undefined;id:bigint}|null{const match=streamIdPattern.exec(selector);if(!match)return null;const raw=match[2]!.trimStart(),negative=raw.startsWith('-'),text=raw.replace(/^[+-]/,'');const value=BigInt(text.length>1&&text.startsWith('0')&&!/^0x/i.test(text)?'0o'+text.slice(1):text);return{type:match[1],id:negative?-value:value};}
export function validMp4Map(value:string):boolean{const original=value.replace(/^-/, '');if(original.startsWith('0:')&&/^(?:[va]:)?m:/.test(original.slice(2)))return languageSelector(original.slice(2))!==null;const clean=original.replace(/\?$/, '');if(clean==='0')return true;if(!clean.startsWith('0:'))return false;const selector=clean.slice(2);return /^(\d+|[va](?::\d+)?)(?![\s\S])/.test(selector)||streamIdPattern.test(selector);}
export function matchesMp4Track(track:Mp4TrackInfo,selector:string,tracks:readonly Mp4TrackInfo[]):boolean{const metadata=languageSelector(selector);if(metadata)return track.language!==undefined&&(metadata.value===undefined||metadata.value===track.language)&&(metadata.type===undefined||track.type===(metadata.type==='v'?'video':'audio'));const identity=streamId(selector);if(identity)return BigInt(track.id|0)===identity.id&&(identity.type===undefined||track.type===(identity.type==='v'?'video':'audio'));if(selector==='')return true;if(/^\d+$/.test(selector))return track.index===Number(selector);const match=/^([va])(?::(\d+))?$/.exec(selector);if(!match)return unsupported('Unsupported MP4 stream specifier: '+selector);const kind=match[1]==='v'?'video':'audio';return track.type===kind&&(match[2]===undefined||tracks.filter(t=>t.type===kind).findIndex(t=>t.index===track.index)===Number(match[2]));}

export function selectMp4Tracks(tracks:readonly Mp4TrackInfo[],maps:readonly string[],maxSamples:number,video:boolean,audio:boolean):Mp4TrackInfo[]{
 if(!Number.isSafeInteger(maxSamples)||maxSamples<1)throw new ExecutionError('resource-budget','Invalid MP4 mapping budget');
 for(const map of maps)if(!validMp4Map(map))unsupported('Unsupported MP4 mapping: '+map);
 let selected:Mp4TrackInfo[]=[];
 const mappings:{track:Mp4TrackInfo;disabled:boolean}[]=[];
 for(const map of maps){const negative=map.startsWith('-'),raw=negative?map.slice(1):map,metadata=languageSelector(raw.slice(2)),optional=metadata?.optional??map.endsWith('?'),value=metadata?raw:optional?raw.slice(0,-1):raw,selector=value==='0'?'':value.slice(2);
  if(negative){if(!mappings.length&&!optional)throw new ExecutionError('invalid-arguments','Negative MP4 map has no previous mappings');for(const mapping of mappings)if(matchesMp4Track(mapping.track,selector,tracks))mapping.disabled=true;}
  else{const found=tracks.filter(track=>matchesMp4Track(track,selector,tracks));if(!found.length&&!optional)throw new ExecutionError('invalid-arguments','MP4 map matches no streams');if(mappings.length+found.length>maxSamples)throw new ExecutionError('resource-budget','MP4 mapping record budget exceeded');for(const track of found)mappings.push({track,disabled:false});}
 }
 selected=mappings.filter(mapping=>!mapping.disabled).map(mapping=>mapping.track);
 if(!mappings.length){for(const kind of ['video','audio'] as const){let best:Mp4TrackInfo|undefined,score=-1;for(const track of tracks.filter(t=>t.type===kind)){if(kind==='audio'&&track.codecChannels===undefined&&tracks.filter(t=>t.type==='audio').length>1)unsupported('Automatic audio selection requires parsed codec channel configuration');const value=((track.packetCount??track.sampleCount)>0n?100000000:0)+(track.defaultDisposition?5000000:0)+(kind==='video'?track.width*track.height:track.codecChannels??track.containerChannels??0);if(value>score){score=value;best=track;}}if(best)selected.push(best);}}
 selected=selected.filter(track=>track.type==='video'?video:audio);return selected;
}
