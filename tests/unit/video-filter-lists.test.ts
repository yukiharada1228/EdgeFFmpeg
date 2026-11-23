import {expect,it} from 'vitest';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
it('inserts format boundaries when a shared candidate would lose chroma or alpha',()=>{
 const color=compileVideoFilterChain('format=gray|rgba,format=gray|nv12').plan('rgba',5,3);
 expect(color.pixelFormat).toBe('nv12');expect(color.stages.map(stage=>[stage.inputPixelFormat,stage.pixelFormat])).toEqual([['rgba','nv12']]);
 const alpha=compileVideoFilterChain('format=rgba|nv12,format=yuva420p|nv12').plan('rgba',5,3);
 expect(alpha.pixelFormat).toBe('yuva420p');expect(alpha.stages.map(stage=>[stage.inputPixelFormat,stage.pixelFormat])).toEqual([['rgba','yuva420p']]);
});
it('normalizes and freezes candidate lists and rejects canonical duplicates',()=>{
 const graph=compileVideoFilterChain('format=pix_fmts=gray8|nv12');expect(graph.steps[0]).toEqual({name:'format',pixelFormat:null,pixelFormats:['gray','nv12']});
 const step=graph.steps[0]!;expect(Object.isFrozen(step)).toBe(true);if(step.name==='format')expect(Object.isFrozen(step.pixelFormats)).toBe(true);
 for(const description of ['format=gray|gray8','format=rgba|rgba','format=||','format=|0','format=gray|unknown'])expect(()=>compileVideoFilterChain(description)).toThrow();
});
it('accounts for selected intermediate formats before executing the graph',()=>{
 const plan=compileVideoFilterChain('format=rgba|bgra,format=gray').plan('gray',5,3);
 expect(plan.maxFrameBytes).toBe(60);expect(plan.stages.map(stage=>stage.pixelFormat)).toEqual(['rgba','gray']);
 expect(plan.intermediateBytes).toBe(75);
});
