/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavutil/channel_layout.c (Copyright (c) 2006 Michael Niedermayer), the
 * channel_names and channel_layout_map tables and av_channel_layout_describe
 * for native-order masks. See packages/avutil/NOTICE-CHANNEL-LAYOUT-NAME.
 */
/** AVChannel ids 0-62 (channel_names); unnamed ids print as USR<id>, as av_channel_name_bprint does. */
const names:readonly (string|undefined)[]=Object.freeze(Object.assign(new Array<string|undefined>(63).fill(undefined),
 ['FL','FR','FC','LFE','BL','BR','FLC','FRC','BC','SL','SR','TC','TFL','TFC','TFR','TBL','TBC','TBR'],
 Object.fromEntries(['DL','DR','WL','WR','SDL','SDR','LFE2','TSL','TSR','BFC','BFL','BFR','SSL','SSR','TTL','TTR'].map((name,index)=>[29+index,name])),{61:'BIL',62:'BIR'}));
const ids=new Map(names.flatMap((name,id)=>name===undefined?[]:[[name,id] as const]));
/** channel_layout_map in source order, as `ffmpeg -layouts` prints it: the first entry with an equal mask names the layout. */
const map:readonly (readonly [string,bigint])[]=Object.freeze(([
 ['mono','FC'],['stereo','FL+FR'],['2.1','FL+FR+LFE'],['3.0','FL+FR+FC'],['3.0(back)','FL+FR+BC'],['4.0','FL+FR+FC+BC'],['quad','FL+FR+BL+BR'],['quad(side)','FL+FR+SL+SR'],
 ['3.1','FL+FR+FC+LFE'],['5.0','FL+FR+FC+BL+BR'],['5.0(side)','FL+FR+FC+SL+SR'],['4.1','FL+FR+FC+LFE+BC'],['5.1','FL+FR+FC+LFE+BL+BR'],['5.1(side)','FL+FR+FC+LFE+SL+SR'],
 ['6.0','FL+FR+FC+BC+SL+SR'],['6.0(front)','FL+FR+FLC+FRC+SL+SR'],['3.1.2','FL+FR+FC+LFE+TFL+TFR'],['hexagonal','FL+FR+FC+BL+BR+BC'],['6.1','FL+FR+FC+LFE+BC+SL+SR'],
 ['6.1(back)','FL+FR+FC+LFE+BL+BR+BC'],['6.1(front)','FL+FR+LFE+FLC+FRC+SL+SR'],['7.0','FL+FR+FC+BL+BR+SL+SR'],['7.0(front)','FL+FR+FC+FLC+FRC+SL+SR'],['7.1','FL+FR+FC+LFE+BL+BR+SL+SR'],
 ['7.1(wide)','FL+FR+FC+LFE+BL+BR+FLC+FRC'],['7.1(wide-side)','FL+FR+FC+LFE+FLC+FRC+SL+SR'],['5.1.2','FL+FR+FC+LFE+SL+SR+TFL+TFR'],['5.1.2(back)','FL+FR+FC+LFE+BL+BR+TFL+TFR'],
 ['octagonal','FL+FR+FC+BL+BR+BC+SL+SR'],['cube','FL+FR+BL+BR+TFL+TFR+TBL+TBR'],['5.1.4','FL+FR+FC+LFE+SL+SR+TFL+TFR+TBL+TBR'],['7.1.2','FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR'],
 ['7.1.4','FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBL+TBR'],['7.2.3','FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBC+LFE2'],['9.1.4','FL+FR+FC+LFE+BL+BR+FLC+FRC+SL+SR+TFL+TFR+TBL+TBR'],
 ['9.1.6','FL+FR+FC+LFE+BL+BR+FLC+FRC+SL+SR+TFL+TFR+TBL+TBR+TSL+TSR'],['hexadecagonal','FL+FR+FC+BL+BR+BC+SL+SR+TFL+TFC+TFR+TBL+TBC+TBR+WL+WR'],['binaural','BIL+BIR'],['downmix','DL+DR'],
 ['22.2','FL+FR+FC+LFE+BL+BR+FLC+FRC+BC+SL+SR+TC+TFL+TFC+TFR+TBL+TBC+TBR+LFE2+TSL+TSR+BFC+BFL+BFR']
] as const).map(([name,channels])=>Object.freeze([name,channels.split('+').reduce((mask,channel)=>mask|1n<<BigInt(ids.get(channel)!),0n)] as const)));
/** Native description of a native-order channel mask (av_channel_layout_describe): a standard layout's name, otherwise '<n> channels (A+B+…)' in bit order. */
export function channelLayoutName(mask:bigint):string {
  if(typeof mask!=='bigint'||mask<=0n||mask>=1n<<64n)throw new RangeError('Invalid channel mask');
  const named=map.find(([,layout])=>layout===mask);
  if(named)return named[0];
  const channels:string[]=[];
  for(let id=0;id<64;id++)if(mask>>BigInt(id)&1n)channels.push(names[id]??`USR${id}`);
  return `${channels.length} channels (${channels.join('+')})`;
}
