import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
it('executes a connected path in flow order while preserving immutable declaration and label metadata',()=>{
 const graph=compileVideoFilterChain('[middle]scale@resize=13:7[output];[input]hflip@first[middle]');expect(graph.steps.map(step=>step.name)).toEqual(['hflip','scale']);expect(graph.steps.map(step=>step.graph?.declarationIndex)).toEqual([1,0]);expect(graph.steps.map(step=>step.graph?.instanceName)).toEqual(['first','resize']);expect(graph.steps[0]?.graph).toMatchObject({chainIndex:1,inputLabel:'input',outputLabel:'middle'});for(const step of graph.steps){expect(Object.isFrozen(step)).toBe(true);expect(Object.isFrozen(step.graph)).toBe(true);}
 expect(graph.plan('rgba',5,3,{outputPixelFormat:'gray'})).toMatchObject({pixelFormat:'gray',width:13,height:7});expect(compileVideoFilterChain('hflip@').steps[0]?.graph?.instanceName).toBe('');expect(compileVideoFilterChain('null').steps).toEqual([{name:'null'}]);
});
it('consumes matched pads once and permits native label reuse and arbitrary external names',()=>{
 expect(compileVideoFilterChain('[in]hflip[x];[x]vflip[x]').steps.map(step=>step.name)).toEqual(['hflip','vflip']);expect(compileVideoFilterChain('[foo]null[bar]').steps[0]?.graph).toMatchObject({inputLabel:'foo',outputLabel:'bar'});
 expect(compileVideoFilterChain('[in]hflip[\ud800];[\ud801]vflip[out]').steps).toHaveLength(2);expect(compileVideoFilterChain('hflip@\ud800').steps[0]?.graph?.instanceName).toBe('\ufffd');expect(()=>compileVideoFilterChain('\ufeffnull')).toThrow();
 expect(compileVideoFilterChain("['source x']hflip['middle x'];['middle x']vflip['sink x']").steps).toHaveLength(2);
});
it('rejects cycles disconnected paths excess pads and malformed labels before execution',()=>{
 for(const text of ['[x]hflip[x]','[b]hflip[a];[a]vflip[b]','hflip;vflip','[a][b]hflip[out]','hflip[a][b]','[]hflip','[missing','[in]hflip[x];[x]vflip[out];[x]null'])expect(()=>compileVideoFilterChain(text),text).toThrow();
});
it('preflights labelled intermediate expansion before opening any media handle',async()=>{
 let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected input');},async openWrite(){opens++;throw new Error('Unexpected output');}},backend:createMediaBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:32,maxPendingPackets:2,maxCpuTimeMs:10000}}),result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in','-vf','[input]format@expand=rgba[x];[x]format@shrink=gray[output]','-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
});
