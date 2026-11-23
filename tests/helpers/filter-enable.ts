import {createFilterEnableTimeline,flipVideoFrame} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export interface FilterEnableCase {graph:string;ops:(string|number)[][]}
/** Fixed legacy-filter scheduling profile: consume and callback evaluate at the same n. */
export function evaluateFilterEnable(row:FilterEnableCase){
 const names=row.graph.split(',');if(names.some(name=>name!=='hflip'&&name!=='vflip'))throw new Error('Unsupported enable fixture graph');
 const timelines=names.map(()=>createFilterEnableTimeline(true,{numericProfile:'darwin-arm64'})),observations=[];let number=0;
 try{for(const op of row.ops){if(op[0]==='c'){observations.push({kind:'command',code:timelines[Number(op[1])]!.command(String(op[2])).code});}else if(op[0]==='f'){
 const pts=BigInt(op[1]!),known=pts!==-(1n<<63n);let frame:VideoFrameData={width:3,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,3,4,5,6)],linesizes:[3],pts:known?{value:pts,timeBase:{num:1n,den:25n}}:null,metadata:{}};
 for(const [index,name]of names.entries()){const values={seconds:known?Number(pts)*(1/25):NaN,number,width:3,height:2};timelines[index]!.enabled(values);if(timelines[index]!.enabled(values))frame=flipVideoFrame(frame,name==='hflip'?'horizontal':'vertical',{maxFrameBytes:16});}
 const values:number[]=[];for(let y=0;y<2;y++)for(let x=0;x<3;x++)values.push(frame.planes[0]![y*frame.linesizes[0]!+x]!);observations.push({kind:'frame',code:0,pts:known?String(pts):null,duration:'1',width:3,height:2,values});number++;
 }else throw new Error('Unsupported enable fixture operation');}return observations;}finally{for(const timeline of timelines)timeline.dispose();}
}
