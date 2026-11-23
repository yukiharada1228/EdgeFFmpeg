// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavfilter/avfilter.c; see ../NOTICE.
import {compileExpression} from '@edge-ffmpeg/avutil';
import type {CompiledExpression,ExpressionOptions} from '@edge-ffmpeg/avutil';

export interface FilterTimelineFrame {
 readonly seconds:number;
 readonly number:number;
 readonly width:number;
 readonly height:number;
}
export type FilterTimelineOptions=Omit<ExpressionOptions,'constants'>;
/** One evaluation per call. The scheduler supplies Native evaluation stages and n. */
export function createFilterEnableTimeline(supported:boolean,options:FilterTimelineOptions){
 if(typeof supported!=='boolean')throw new Error('Invalid timeline capability');
 const settings={numericProfile:options.numericProfile,...(options.nowMicroseconds?{nowMicroseconds:options.nowMicroseconds}:{}),...(options.onPrint?{onPrint:options.onPrint}:{}),...(options.logLevel===undefined?{}:{logLevel:options.logLevel})};
 compileExpression('1',settings);
 let compiled:CompiledExpression|undefined,invalidated=false,disposed=false;
 const active=()=>{if(disposed)throw new Error('Filter enable timeline disposed');};
 return {
  command(expression:string){
   active();
   if(typeof expression!=='string'||expression.length>4096||expression.includes('\0'))throw new Error('Invalid enable expression');
   if(!supported)return {code:-(80+65*256+87*65536+69*16777216)};
   try{const next=compileExpression(expression,{...settings,constants:['t','n','w','h']});compiled=next;invalidated=false;return {code:0};}
   catch{invalidated=compiled!==undefined;return {code:-22};}
  },
  enabled(frame:FilterTimelineFrame){
   active();
   const {seconds,number,width,height}=frame;
   if(typeof seconds!=='number'||!Number.isFinite(number)||!Number.isInteger(number)||number<0||![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=2147483647))throw new Error('Invalid filter timeline frame');
   if(invalidated)throw new Error('Native enable timeline invalidated by failed replacement');
   return compiled?Math.abs(compiled([seconds,number,width,height]))>=0.5:true;
  },
  dispose(){if(disposed)return;disposed=true;compiled=undefined;invalidated=false;delete settings.onPrint;delete settings.nowMicroseconds;}
 };
}
