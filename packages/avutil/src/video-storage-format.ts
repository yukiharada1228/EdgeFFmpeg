/** Legacy JPEG-range names share byte storage with ordinary planar YUV.
 * This maps layout only; callers must retain or infer range metadata. */
export function videoStoragePixelFormat(format:string):string {
 switch(format){case 'yuvj420p':return 'yuv420p';case 'yuvj422p':return 'yuv422p';case 'yuvj444p':return 'yuv444p';default:return format;}
}
