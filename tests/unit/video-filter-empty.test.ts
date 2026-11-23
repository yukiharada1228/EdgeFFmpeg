import {expect,it} from 'vitest';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
it('preserves default-filter semantics when the whole option string is empty',()=>{
 for(const name of ['null','scale','format','hflip','vflip']){
  const bare=compileVideoFilterChain(name).plan('rgba',5,3,{outputPixelFormat:'nv12',outputSize:{width:3,height:2}}),empty=compileVideoFilterChain(name+'=').plan('rgba',5,3,{outputPixelFormat:'nv12',outputSize:{width:3,height:2}});
  expect(empty.stages).toEqual(bare.stages);expect(empty.pixelFormat).toBe(bare.pixelFormat);expect(empty.stateBytes).toBe(bare.stateBytes);
 }
});
it('distinguishes explicit empty pixel-format values from unconstrained whole-option defaults',()=>{
 expect(compileVideoFilterChain('format=pix_fmts=').steps[0]).toMatchObject({name:'format',pixelFormats:['yuv420p']});expect(compileVideoFilterChain('format=').steps[0]).toMatchObject({name:'format',pixelFormats:null});
});
