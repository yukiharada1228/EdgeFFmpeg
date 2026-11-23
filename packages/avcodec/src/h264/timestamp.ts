// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from guess_correct_pts in FFmpeg libavcodec/decode.c at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8; see NOTICE-H264-TIMESTAMP.
/** Decoder presentation-order timestamp correction; raw frame PTS stays intact. */
export function createH264TimestampCorrection(){
 let faultyPts=0n,faultyDts=0n,lastPts=-(1n<<63n),lastDts=-(1n<<63n);
 return (pts:bigint|null,dts:bigint|null):bigint|null=>{
  if(dts!==null){if(dts<=lastDts)faultyDts++;lastDts=dts;}else if(pts!==null)lastDts=pts;
  if(pts!==null){if(pts<=lastPts)faultyPts++;lastPts=pts;}else if(dts!==null)lastPts=dts;
  return (faultyPts<=faultyDts||dts===null)&&pts!==null?pts:dts;
 };
}
