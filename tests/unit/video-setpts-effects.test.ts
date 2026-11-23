import {it,expect} from 'vitest';
import {createVideoPtsTransform,createSetptsStream} from '@edge-ffmpeg/avfilter';
import type {ExpressionPrint} from '@edge-ffmpeg/avutil';
const base={num:1n,den:25n},settings={numericProfile:'linux-x64' as const,timeBase:base,frameRate:{num:25n,den:1n}};
it('preserves snapshotted print effects and log level through setpts commands and EOF',()=>{
 const entries:ExpressionPrint[]=[],options={...settings,expression:'print(N,48);PTS',logLevel:32,onPrint:(entry:ExpressionPrint)=>{entries.push(entry);}},stage=createVideoPtsTransform(options);
 stage.process({pts:0n,duration:1n});expect(entries).toEqual([]);
 options.onPrint=()=>{throw new Error('Mutated callback');};options.logLevel=0;
 stage.command('print(N,16);PTS');expect(stage.process({pts:1n,duration:1n}).pts).toBe(1n);
 expect(()=>stage.command('print(')).toThrow();expect(stage.finish(2n)).toBe(2n);
 expect(entries).toEqual([{value:1,level:16,text:'1.000000\n'},{value:2,level:16,text:'2.000000\n'}]);
});
it('evaluates print once per requested frame and explicit EOF without read-ahead',async()=>{
 const entries:ExpressionPrint[]=[],stage=createSetptsStream(()=>({async *[Symbol.asyncIterator](){for(let i=0;i<3;i++)yield {kind:'frame' as const,duration:1n,frame:{width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(i)],linesizes:[1],metadata:{},pts:{value:BigInt(i),timeBase:base}}};yield {kind:'end' as const,status:'eof' as const,pts:3n};}}),{...settings,expression:'print(N,16);PTS',maxFrameBytes:8,onPrint:entry=>entries.push(entry)}),iterator=stage.open()[Symbol.asyncIterator]();
 expect(entries).toEqual([]);await iterator.next();expect(entries.map(entry=>entry.value)).toEqual([0]);
 for(;;){const next=await iterator.next();if(next.done)break;}
 expect(entries.map(entry=>entry.value)).toEqual([0,1,2,3]);expect((await stage.completion).status).toBe('eof');
});
it('retains an input error when EOF print and source cleanup both fail',async()=>{
 const input=new Error('Input EIO'),effect=new Error('Print callback'),cleanup=new Error('Source cleanup');let returned=0;
 const stage=createSetptsStream(()=>({[Symbol.asyncIterator](){return {async next(){return {done:false as const,value:{kind:'end' as const,status:'error' as const,pts:0n,error:input}};},async return(){returned++;throw cleanup;}};}}),{...settings,expression:'print(N);PTS',maxFrameBytes:8,onPrint(){throw effect;}});
 const end=await stage.open()[Symbol.asyncIterator]().next();expect(end.value).toMatchObject({kind:'end',status:'error',error:input,secondaryErrors:[effect,cleanup]});expect(returned).toBe(1);
});
