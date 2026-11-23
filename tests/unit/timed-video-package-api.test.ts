import {it,expect} from 'vitest';
import {resizeNeighborVideoFrame,resizeBilinearVideoFrame,resizeAreaVideoFrame,PixelResizeError} from '@edge-ffmpeg/swscale';
import {snapshotFrameMetadata} from '@edge-ffmpeg/avutil';
it('shares public resize errors across all three interpolation kernels',()=>{
 const frame={width:3,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,3,4,5,6)],linesizes:[3],metadata:{},pts:null};
 for(const resize of [resizeNeighborVideoFrame,resizeBilinearVideoFrame,resizeAreaVideoFrame]){expect(()=>resize(frame,4,3,{maxFrameBytes:1,maxStateBytes:4096})).toThrow(PixelResizeError);expect(()=>resize(frame,4,3,{maxFrameBytes:4096,maxStateBytes:0})).toThrow(PixelResizeError);}
});
it('owns sample-aspect metadata and rejects invalid bounded rationals',()=>{
 const sar={num:2n,den:1n},copy=snapshotFrameMetadata({sampleAspectRatio:sar,label:'frame'});sar.num=9n;expect(copy).toEqual({sampleAspectRatio:{num:2n,den:1n},label:'frame'});expect(Object.isFrozen(copy.sampleAspectRatio)).toBe(true);
 for(const value of [null,{num:-1n,den:1n},{num:1n,den:0n},{num:1n<<40n,den:1n}])expect(()=>snapshotFrameMetadata({sampleAspectRatio:value})).toThrow();
});
