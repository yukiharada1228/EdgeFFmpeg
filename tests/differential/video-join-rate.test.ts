import {expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {synchronizationTimeBase,videoOperator,videoJoinFrameRate,videoJoinPlan} from '@edge-ffmpeg/avfilter';
import {collectingOutput} from '../helpers/output.js';
import {backends,compareJoinRates,ffmpeg,frontend,lengthPairs,native,pattern,ratePairs,rational,raw} from '../helpers/video-join-rate.js';
import {joinStandIns,mixedJoinStandIn} from '../helpers/video-join-stand-ins.js';
// Base-rate joins run through stand-ins registered as a new join operator is (tests/helpers/video-join-stand-ins.ts).
vi.mock('../../packages/avfilter/src/video-ops/registry.js',async importOriginal=>(await import('../helpers/video-join-stand-ins.js')).withJoinStandIns(await importOriginal()));
const metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
it('runs against the reference built from commit 946fcce0 with --disable-x86asm',()=>{
 expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');expect(existsSync(ffmpeg)).toBe(true);
});
it('keeps the vf_stack clock of hstack and vstack with unequal rates and lengths in both input orders on the stream, actor and timed paths',async()=>{
 // 4 rate pairs x 2 length pairs x 3 backends: 2 muxers identical, -enc_time_base demux refused by both sides.
 for(const [filter,inputs]of [['hstack',2],['vstack=inputs=3:shortest=1',3]] as const)expect(await compareJoinRates({ours:filter,inputs,props:'none'}),filter).toEqual([48,24]);
},240000);
it('gives base-rate joins input 0\'s rate, props and after modes with unequal rates and lengths in both input orders on the stream, actor and timed paths',async()=>{
 for(const {op,native:theirs,inputs,fill}of joinStandIns){
  const props=op.join!.props??'none';
  // av_frame_copy_props carries input 0's decoder time base, so -enc_time_base demux succeeds as natively.
  expect(await compareJoinRates({ours:op.name,theirs,inputs,props,fill}),theirs).toEqual(props==='base'?[72,0]:[48,24]);
 }
},240000);
it('refuses a join that mixes EXT_STOP and EXT_INFINITY before any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-join-rate-mixed-'));
 try{
  const data=[pattern(5,1),pattern(2,2)],files=new Map(data.map((value,index)=>[`/${index}`,value]));for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
  const args=(filter:string,path:(index:number)=>string)=>[...data.flatMap((_,index)=>raw(index?'10':'25',path(index))),'-filter_complex',`[0:v][1:v]${filter}[o]`,'-map','[o]','-f','framecrc'];
  // vf_mix duration=first: in[0].after=EXT_STOP and in[1].after=EXT_INFINITY, which native runs and the shared synchronizer does not.
  const expected=native(args(mixedJoinStandIn.native,index=>join(root,`${index}.raw`)));expect(expected.status).toBe(0);expect(expected.stdout.length).toBeGreaterThan(0);
  for(const [name,backend]of Object.entries(backends)){
   const sink=collectingOutput(),result=await frontend(files,backend(),()=>sink.output).exec(['-y',...args(mixedJoinStandIn.op.name,index=>`/${index}`),'/out']);
   expect(result.exitCode,name).not.toBe(0);expect(sink.committed,name).toBe(false);expect(sink.bytes().length,name).toBe(0);
   expect(JSON.stringify(result.diagnostics),name).toContain('mixes EXT_STOP and EXT_INFINITY across its inputs');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
/** Every native framesync join with the rule its source declares: base-rate filters copy input 0's link rate, and those
 * calling av_frame_copy_props carry input 0's props; vf_stack joins do neither. after is the in[i].after mode native
 * configures with default options, read from the output length of unequal inputs. */
const nativeJoins:readonly (readonly [string,number,'common'|'base','none'|'base','stop'|'infinity'])[]=[
 ['maskedmerge',3,'base','base','infinity'],['maskedmin',3,'base','base','infinity'],['maskedmax',3,'base','base','infinity'],['maskedclamp',3,'base','base','infinity'],['maskedthreshold',2,'base','base','infinity'],['threshold',4,'base','base','stop'],
 ['xmedian',3,'base','none','infinity'],['limitdiff',2,'base','base','infinity'],['midequalizer',2,'base','base','infinity'],['hysteresis',2,'base','base','infinity'],['mix',2,'base','none','infinity'],
 ['hstack',2,'common','none','infinity'],['vstack',2,'common','none','infinity'],['xstack',2,'common','none','infinity']];
it('declares the native output clock, props and after mode of every framesync join, and registered joins declare the same rule',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-join-rate-rule-'));let count=0;const registered:string[]=[];
 try{
  for(const [filter,inputs,rate,props,after]of nativeJoins){
   const op=videoOperator(filter);
   if(op){expect(op.role,filter).toBe('join');expect(videoJoinPlan(op,op.parse!({name:filter,options:null}).configuration,inputs),filter).toEqual({rate,props,shortest:after==='stop'});registered.push(filter);}
   const graph=`${Array.from({length:inputs},(_,index)=>`[${index}:v]`).join('')}${filter}[o]`;
   for(const rates of ratePairs){
    for(let index=0;index<inputs;index++)writeFileSync(join(root,`${index}.raw`),pattern(3,index));
    const args=(extra:readonly string[])=>[...Array.from({length:inputs},(_,index)=>raw(index?rates[1]:rates[0],join(root,`${index}.raw`))).flat(),'-filter_complex',graph,'-map','[o]',...extra,'-f','framecrc'];
    const clocks=Array.from({length:inputs},(_,index)=>rational(index?rates[1]:rates[0])),frameRate=videoJoinFrameRate(rate,clocks),timeBase=frameRate.den?{num:frameRate.den,den:frameRate.num}:synchronizationTimeBase(clocks.map(q=>({num:q.den,den:q.num})));
    const plain=native(args([])),label=`${filter}/${rates}`;expect(plain.status,label).toBe(0);expect(/^#tb 0: (\d+\/\d+)$/m.exec(plain.stdout.toString())?.[1],label).toBe(`${timeBase.num}/${timeBase.den}`);
    // -enc_time_base demux reads the decoder time base that av_frame_copy_props carries from input 0.
    const demux=native(args(['-enc_time_base','demux']));
    if(props==='base'){expect(demux.status,label).toBe(0);expect(/^#tb 0: (\d+\/\d+)$/m.exec(demux.stdout.toString())?.[1],label).toBe(`${clocks[0]!.den}/${clocks[0]!.num}`);}
    else{expect(demux.status,label).toBe(234);expect(demux.stdout.length,label).toBe(0);}
    count++;
   }
   for(const lengths of lengthPairs){
    for(let index=0;index<inputs;index++)writeFileSync(join(root,`${index}.raw`),pattern(index?lengths[1]:lengths[0],index));
    const result=native([...Array.from({length:inputs},(_,index)=>raw('25',join(root,`${index}.raw`))).flat(),'-filter_complex',graph,'-map','[o]','-f','framecrc']);
    expect(result.status,filter).toBe(0);expect(result.stdout.toString().split('\n').filter(line=>/^0,/.test(line)).length,`${filter}/${lengths}`).toBe(after==='stop'?2:5);count++;
   }
  }
  expect(count).toBe(84);expect(registered).toEqual(expect.arrayContaining(['hstack','vstack']));
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
