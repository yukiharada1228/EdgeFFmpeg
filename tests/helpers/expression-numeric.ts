import {evaluateExpression} from '@edge-ffmpeg/avutil';
import {glibcExp2} from '../../packages/avutil/src/expression/glibc-exp2.js';
export function numericResult(expression:string):{valueAccepted:boolean;bits:string}{
 let value=NaN,valueAccepted=true;
 try{
  value=expression.startsWith('@exp2:')?glibcExp2(Number(expression.slice(6).replace(/^inf$/,'Infinity').replace(/^-inf$/,'-Infinity'))):evaluateExpression(expression,{numericProfile:'linux-x64'});
  valueAccepted=!Number.isNaN(value);
 }catch{valueAccepted=false;}
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);
 return {valueAccepted,bits:view.getBigUint64(0,false).toString(16).padStart(16,'0')};
}
