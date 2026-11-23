import {FeatureRegistry} from '@edge-ffmpeg/core';
import type {OperatorDescriptor,CommandOperatorBinding,ExecutionGraph} from '@edge-ffmpeg/core';
export const complexCommandBudget={maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:15000,maxPendingPackets:16};
export const complexCommandInput=Uint8Array.from({length:12},(_,index)=>index*17+3);
/** Portable metadata only: intentionally reversed edge order distinguishes pad
 * declaration order from accidental edge traversal order in hstack lowering. */
export function complexCommandGraph(mode:'join'|'outputs'){
 const registry=new FeatureRegistry<OperatorDescriptor>(),bindings=new Map<string,CommandOperatorBinding>(),nodes:ExecutionGraph['nodes'][number][]=[],edges:ExecutionGraph['edges'][number][]=[];
 const add=(id:string,kind:OperatorDescriptor['kind'],inputs:OperatorDescriptor['inputs'],outputs:OperatorDescriptor['outputs'],binding:CommandOperatorBinding)=>{
  registry.register({id,kind,inputs,outputs,status:'partial',runtimes:['node','cloudflare'],testCases:[],traits:{state:kind==='filter'?'stateless':'stateful',access:'sequential',checkpointable:false,temporal:kind!=='filter',deterministic:true,minimumMemoryBytes:1024,estimatedCpuTimeMs:1}});nodes.push({id,featureId:id});bindings.set(id,binding);
 };
 const packet=(name:string)=>({name,type:'packet' as const}),video=(name:string)=>({name,type:'video-frame' as const});
 const edge=(from:string,out:string,to:string,input:string)=>edges.push({from:{node:from,port:out},to:{node:to,port:input},queueCapacity:1});
 add('source','source',[],[packet('out')],{kind:'source',path:'/input/video.raw',key:'source/video.raw',options:['-f','rawvideo','-pixel_format','gray','-video_size','2x2','-framerate','25']});
 add('decode','decode',[packet('in')],[video('out')],{kind:'input-options',options:[]});
 add('split','filter',[video('in')],[video('left'),video('right')],{kind:'filter',mediaType:'video',expression:'split=2'});
 add('flip','filter',[video('in')],[video('out')],{kind:'filter',mediaType:'video',expression:'hflip'});
 add('identity','filter',[video('in')],[video('out')],{kind:'filter',mediaType:'video',expression:'null'});
 edge('source','out','decode','in');edge('decode','out','split','in');edge('split','left','flip','in');edge('split','right','identity','in');
 const terminal=(label:string,upstream:string)=>{
  add(label+'-encode','encode',[video('in')],[packet('out')],{kind:'output-options',options:['-c:v','rawvideo']});
  add(label+'-mux','mux',[packet('in')],[packet('out')],{kind:'output-options',options:['-f','rawvideo']});
  add(label+'-sink','sink',[packet('in')],[],{kind:'sink',path:'/output/'+label+'.raw'});
  edge(upstream,'out',label+'-encode','in');edge(label+'-encode','out',label+'-mux','in');edge(label+'-mux','out',label+'-sink','in');
 };
 if(mode==='join'){
  add('stack','filter',[video('left'),video('right')],[video('out')],{kind:'filter',mediaType:'video',expression:'hstack=inputs=2'});edge('flip','out','stack','left');edge('identity','out','stack','right');terminal('joined','stack');
 }else{terminal('left','flip');terminal('right','identity');}
 return {graph:{nodes,edges:edges.reverse()},registry,bindings};
}
