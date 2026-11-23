import {expect,it} from 'vitest';
import {selectReferencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('selects explicit arithmetic from the recorded oracle rather than the execution host',()=>{
 expect(selectReferencePixelArithmetic({platform:'darwin',arch:'arm64',flags:['--disable-x86asm']})).toBe('aarch64');
 expect(selectReferencePixelArithmetic({platform:'linux',arch:'x64',flags:['--disable-x86asm']})).toBe('x86_64');
});
it('rejects unverified reference targets and x86 external-assembly configurations',()=>{
 for(const reference of [{platform:'linux',arch:'x64',flags:[]},{platform:'linux',arch:'arm64',flags:['--disable-x86asm']},{platform:'win32',arch:'x64',flags:['--disable-x86asm']}])expect(()=>selectReferencePixelArithmetic(reference)).toThrow('Unverified');
});
