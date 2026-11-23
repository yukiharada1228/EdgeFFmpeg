import {it,expect} from 'vitest';
import {synchronizeFrames,synchronizationTimeBase} from '@edge-ffmpeg/avfilter';
import type {Timestamp,Rational} from '@edge-ffmpeg/avutil';
interface Frame{pts:Timestamp|null;value:number}
const base={num:1n,den:25n};
function source(points:readonly bigint[],timeBase:Rational=base){let pulls=0,closed=false;return {timeBase,frames:{async *[Symbol.asyncIterator](){try{for(const [index,value]of points.entries()){pulls++;yield {pts:{value,timeBase},value:index};}}finally{closed=true;}}},get pulls(){return pulls;},get closed(){return closed;}};}
function options(extra:{shortest?:boolean;signal?:AbortSignal;maxResidentBytes?:number}={}){let live=0,peak=0,releases=0;return {maxPendingFrames:4,maxResidentBytes:4,...extra,timestamp:(frame:Frame)=>frame.pts,retain(frame:Frame,available:number){if(available<1)throw new Error('No lease space');live++;peak=Math.max(peak,live);let released=false;return {value:{...frame,pts:frame.pts?{value:frame.pts.value,timeBase:{...frame.pts.timeBase}}:null},bytes:1,release(){if(released)throw new Error('Double release');released=true;live--;releases++;}};},get live(){return live;},get peak(){return peak;},get releases(){return releases;}};}
async function collect(a:ReturnType<typeof source>,b:ReturnType<typeof source>,o=options()){const values=[];for await(const event of synchronizeFrames([a,b],o))values.push({pts:event.pts,values:event.frames.map(frame=>frame.value)});return values;}
it('merges explicit input timelines with stop-before and repeat-last semantics',async()=>{
 const a=source([0n,2n,4n]),b=source([1n,3n]),o=options(),events=await collect(a,b,o);expect(events.map(x=>[x.pts.value,x.values])).toEqual([[1n,[0,0]],[2n,[1,0]],[3n,[1,1]],[4n,[2,1]]]);expect(o.live).toBe(0);expect(o.peak).toBeLessThanOrEqual(4);expect(o.releases).toBe(5);
});
it('terminates shortest at the final input tick plus one and closes held iterators',async()=>{
 const a=source([0n,2n,4n]),b=source([0n,1n]),o=options({shortest:true}),events=await collect(a,b,o);expect(events.map(x=>x.pts.value)).toEqual([0n,1n]);expect(a.closed).toBe(true);expect(b.closed).toBe(true);expect(o.live).toBe(0);
 const c=source([]),d=source([0n,1n]);expect(await collect(c,d)).toEqual([]);expect(d.closed).toBe(true);
});
it('selects native common time bases and preserves exact values above number precision',async()=>{
 expect(synchronizationTimeBase([{num:1n,den:25n},{num:1n,den:30n}])).toEqual({num:1n,den:150n});expect(synchronizationTimeBase([{num:1n,den:500000n},{num:1n,den:500000n}])).toEqual({num:1n,den:1000000n});
 const n=9007199254740993n,events=await collect(source([n]),source([n*2n],{num:1n,den:50n}));expect(events).toEqual([{pts:{value:n*2n,timeBase:{num:1n,den:50n}},values:[0,0]}]);
});
it('preflights invalid bounds before acquiring sources and releases owned frames on budget failure',async()=>{
 let acquisitions=0;const s={timeBase:base,frames:{[Symbol.asyncIterator](){acquisitions++;throw new Error('Acquired');}}},o=options();expect(()=>synchronizeFrames([s,s],{...o,maxPendingFrames:3})).toThrow(/budget/);expect(acquisitions).toBe(0);
 const a=source([0n,1n]),b=source([0n,1n]),limited=options({maxResidentBytes:2});await expect(collect(a,b,limited)).rejects.toThrow(/space/);expect(limited.live).toBe(0);expect(a.closed&&b.closed).toBe(true);
});
it('retains one lookahead per input without prefetching after a yielded event and closes on cancellation',async()=>{
 const a=source([0n,2n,4n]),b=source([0n,1n,3n]),controller=new AbortController(),o=options({signal:controller.signal}),iterator=synchronizeFrames([a,b],o)[Symbol.asyncIterator]();expect(a.pulls+b.pulls).toBe(0);await iterator.next();expect([a.pulls,b.pulls]).toEqual([1,1]);controller.abort();await expect(iterator.next()).rejects.toThrow();expect(a.pulls+b.pulls).toBe(2);expect(a.closed&&b.closed).toBe(true);expect(o.live).toBe(0);
});
it('rejects changing timestamps and preserves processing errors over cleanup failures',async()=>{
 async function* bad(){yield {value:0,pts:{value:0n,timeBase:base}};yield {value:1,pts:{value:1n,timeBase:{num:1n,den:30n}}};}
 const a={timeBase:base,frames:bad()},b=source([0n,1n]),o=options();const values=synchronizeFrames([a,b],{...o,retain(frame,available){const lease=o.retain(frame,available);return {...lease,release(){lease.release();throw new Error('cleanup');}};}});await expect(async()=>{for await(const event of values)expect(event.frames).toHaveLength(2);}).rejects.toThrow(/timestamp/);expect(o.live).toBe(0);
});
it('snapshots source descriptors and uses explicit retained ownership when a producer reuses frame objects',async()=>{
 const shared:Frame={pts:{value:0n,timeBase:base},value:0};const a={timeBase:base,frames:{async *[Symbol.asyncIterator](){for(let i=0;i<3;i++){shared.pts={value:BigInt(i*2),timeBase:base};shared.value=i;yield shared;}}}},b=source([0n,1n,3n]),sources=[a,b],o=options(),stream=synchronizeFrames(sources,o);sources.push(source([99n]));sources[0]={timeBase:base,frames:source([]).frames};
 const actual=[];for await(const event of stream)actual.push([event.pts.value,...event.frames.map(x=>x.value)]);expect(actual).toEqual([[0n,0,0],[1n,0,1],[2n,1,1],[3n,1,2],[4n,2,2]]);expect(o.live).toBe(0);
});
it('runs every release and iterator cleanup even if one cleanup fails during early termination',async()=>{
 const a=source([0n,2n]),b=source([0n,1n]),o=options(),iterator=synchronizeFrames([a,b],{...o,retain(frame,available){const lease=o.retain(frame,available);return {...lease,release(){lease.release();throw new Error('release failed');}};}})[Symbol.asyncIterator]();await iterator.next();await expect(iterator.return?.()).rejects.toThrow(/release failed/);expect(o.live).toBe(0);expect(a.closed&&b.closed).toBe(true);
});

it('preserves unreduced rational representations when selecting the Native join clock',()=>{
 expect(synchronizationTimeBase([{num:1n,den:25n},{num:2n,den:50n}])).toEqual({num:1n,den:50n});
 expect(synchronizationTimeBase([{num:2n,den:50n},{num:4n,den:100n}])).toEqual({num:2n,den:100n});
});
it('keeps unknown timestamps as synchronization sentinels and releases every retained lease',async()=>{
 const a={timeBase:base,frames:{async *[Symbol.asyncIterator](){yield {pts:null,value:10};yield {pts:{value:0n,timeBase:base},value:11};yield {pts:null,value:12};}}},b={timeBase:base,frames:{async *[Symbol.asyncIterator](){yield {pts:null,value:100};yield {pts:{value:0n,timeBase:base},value:101};yield {pts:null,value:102};}}},o=options(),events=[];
 for await(const event of synchronizeFrames([a,b],o))events.push([event.pts.value,event.frames.map(frame=>frame.value)]);
 expect(events).toEqual([[-9223372036854775808n,[10,100]],[0n,[11,101]],[-9223372036854775808n,[12,102]]]);expect(o.live).toBe(0);expect(o.releases).toBe(6);expect(o.peak).toBeLessThanOrEqual(4);
});
