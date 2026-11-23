export type VideoPixelFormat='gray'|'rgb24'|'bgr24'|'rgba'|'bgra'|'argb'|'abgr'|'yuv420p'|'yuv422p'|'yuv444p'|'yuva420p'|'nv12'|'nv21'|'gbrp'|'rgb555le'|'rgb565le'|'rgb444le'|'rgb0'|'bgr0'|'0rgb'|'0bgr'|'rgb8'|'bgr8'|'rgb4_byte'|'bgr4_byte'|'pal8'|'monob';
export class PixelLayoutError extends Error {}
export interface PixelPlaneLayout {readonly width:number;readonly height:number;readonly rowBytes:number;readonly offset:number;readonly bytes:number}
export interface PixelLayout {readonly width:number;readonly height:number;readonly pixelFormat:VideoPixelFormat;readonly bytes:number;readonly planes:readonly PixelPlaneLayout[]}
/** Tight wire layouts, including packed samples and separate palette storage. No color conversion, row alignment or payload allocation. */
export function pixelLayout(pixelFormat:string,width:number,height:number):PixelLayout{
  if(!Number.isInteger(width)||width<1||width>2147483647||!Number.isInteger(height)||height<1||height>2147483647)throw new PixelLayoutError('Invalid video dimensions');
  const format=pixelFormat==='gray8'?'gray':pixelFormat,halfWidth=Math.ceil(width/2),halfHeight=Math.ceil(height/2);
  let shapes:readonly (readonly [number,number,number,number?])[];
  switch(format){
    case 'rgb555le':case 'rgb565le':case 'rgb444le':shapes=[[width,height,2]];break;
    case 'monob':shapes=[[width,height,1,Math.ceil(width/8)]];break;
    case 'pal8':shapes=[[width,height,1],[256,1,4]];break;
    case 'rgb8':case 'bgr8':case 'rgb4_byte':case 'bgr4_byte':
    case 'gray':shapes=[[width,height,1]];break;
    case 'rgb24':case 'bgr24':shapes=[[width,height,3]];break;
    case 'rgba':case 'bgra':case 'argb':case 'abgr':case 'rgb0':case 'bgr0':case '0rgb':case '0bgr':shapes=[[width,height,4]];break;
    case 'yuv420p':shapes=[[width,height,1],[halfWidth,halfHeight,1],[halfWidth,halfHeight,1]];break;
    case 'yuva420p':shapes=[[width,height,1],[halfWidth,halfHeight,1],[halfWidth,halfHeight,1],[width,height,1]];break;
    case 'yuv422p':shapes=[[width,height,1],[halfWidth,height,1],[halfWidth,height,1]];break;
    case 'yuv444p':case 'gbrp':shapes=[[width,height,1],[width,height,1],[width,height,1]];break;
    case 'nv12':case 'nv21':shapes=[[width,height,1],[halfWidth,halfHeight,2]];break;
    default:throw new PixelLayoutError(`Unsupported video pixel format: ${pixelFormat}`);
  }
  let total=0n;const planes=shapes.map(([columns,rows,components,explicitRowBytes])=>{
    const rowBytes=explicitRowBytes===undefined?BigInt(columns)*BigInt(components):BigInt(explicitRowBytes),bytes=rowBytes*BigInt(rows),offset=total;total+=bytes;
    if(total>2147483647n)throw new PixelLayoutError('Video frame exceeds signed32 packet size');
    return Object.freeze({width:columns,height:rows,rowBytes:Number(rowBytes),bytes:Number(bytes),offset:Number(offset)});
  });
  return Object.freeze({width,height,pixelFormat:format as VideoPixelFormat,bytes:Number(total),planes:Object.freeze(planes)});
}
