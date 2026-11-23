import {expect,it} from 'vitest';
import {convertVideoFrame,canConvertPixelFormat} from '@edge-ffmpeg/swscale';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
function frame(pixelFormat:string,width:number,bytes:number[]){return decodeRawVideo({streamIndex:0,data:new Uint8Array(bytes),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{width,height:1,pixelFormat},{maxFrameBytes:1024});}
it('uses native default BT601 coefficients and intermediate rounding for RGB primaries and a half-way boundary',()=>{
 const input=frame('rgb24',6,[0,0,0,255,255,255,255,0,0,0,255,0,0,0,255,177,143,20]),converted=convertVideoFrame(input,'yuv444p',{maxFrameBytes:1024});expect(converted.planes.map(value=>[...value])).toEqual([[16,235,81,145,41,136],[128,128,90,54,240,69],[128,128,240,34,110,152]]);expect(converted.pts).toEqual(input.pts);expect(converted.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
});
it('preserves native YUV444 clipping and signed 32-bit super-white blue behavior before producing opaque alpha',()=>{
 const input=frame('yuv444p',4,[254,16,235,128,255,128,128,82,160,128,128,125]),converted=convertVideoFrame(input,'rgba',{maxFrameBytes:1024});expect([...converted.planes[0]!]).toEqual([255,201,0,255,0,0,0,255,255,255,255,255,126,151,38,255]);
 expect(convertVideoFrame({...input,pts:null},'gbrp',{maxFrameBytes:1024}).pts).toBeNull();
});
it('converts full and limited gray ranges while keeping neutral chroma and opaque YUV alpha',()=>{
 const input=frame('gray',8,[0,16,64,128,235,255,1,254]),yuv=convertVideoFrame(input,'yuva420p',{maxFrameBytes:1024});expect(yuv.planes.map(value=>[...value])).toEqual([[16,30,71,126,218,235,17,234],[128,128,128,128],[128,128,128,128],[255,255,255,255,255,255,255,255]]);
 expect([...convertVideoFrame(frame('yuv444p',8,[0,16,64,128,235,255,1,254,...Array(16).fill(128)]),'gray',{maxFrameBytes:1024}).planes[0]!]).toEqual([0,0,56,130,255,255,0,255]);
 const rgb=convertVideoFrame(input,'rgb24',{maxFrameBytes:1024});expect([...rgb.planes[0]!]).toEqual([0,0,0,16,16,16,64,64,64,128,128,128,235,235,235,255,255,255,1,1,1,254,254,254]);
});
it('reads padded RGB color planes without padding contamination and retains explicit unsupported chroma conversions',()=>{
 const input=frame('gbrp',2,[0,255,0,0,255,0]),padded={...input,planes:input.planes.map(plane=>new Uint8Array([...plane,99,99])),linesizes:[4,4,4]},output=convertVideoFrame(padded,'yuv444p',{maxFrameBytes:64});expect(output.planes.map(value=>[...value])).toEqual([[81,145],[90,54],[240,34]]);expect(canConvertPixelFormat('rgba','yuv444p')).toBe(true);expect(canConvertPixelFormat('yuv420p','rgb24')).toBe(true);expect(canConvertPixelFormat('yuv444p','nv12')).toBe(true);
});
