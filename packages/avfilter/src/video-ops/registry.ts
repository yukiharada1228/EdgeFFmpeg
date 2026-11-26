// SPDX-License-Identifier: LGPL-2.1-or-later
// The video operator registry: adding an operator is one descriptor module plus one line here.
import {videoExecutionPaths} from './descriptor.js';
import type {VideoOperatorDescriptor,VideoExecutionPath,VideoOperatorRole} from './descriptor.js';
import {nullOperator} from './null.js';
import {formatOperator} from './format.js';
import {scaleOperator} from './scale.js';
import {hflipOperator} from './hflip.js';
import {vflipOperator} from './vflip.js';
import {transposeOperator} from './transpose.js';
import {negateOperator} from './negate.js';
import {splitOperator} from './split.js';
import {nullsinkOperator} from './nullsink.js';
import {hstackOperator} from './hstack.js';
import {vstackOperator} from './vstack.js';
import {cropOperator} from './crop.js';
import {setsarOperator} from './setsar.js';
import {setdarOperator} from './setdar.js';
import {setptsOperator} from './setpts.js';
import {copyOperator} from './copy.js';
import {ilOperator} from './il.js';
import {fieldOperator} from './field.js';
import {epxOperator} from './epx.js';
import {swapuvOperator} from './swapuv.js';
import {limiterOperator} from './limiter.js';
import {pixelizeOperator} from './pixelize.js';
import {shuffleplanesOperator} from './shuffleplanes.js';
import {chromashiftOperator} from './chromashift.js';
import {erosionOperator} from './erosion.js';
import {dilationOperator} from './dilation.js';
import {deflateOperator} from './deflate.js';
import {inflateOperator} from './inflate.js';
import {fillbordersOperator} from './fillborders.js';
import {swaprectOperator} from './swaprect.js';
// One import above and one entry below per operator, each entry ending with a comma, so parallel
// additions never touch the same line. Order is irrelevant: lookups are by name.
export const videoOperators=Object.freeze([
 nullOperator,
 formatOperator,
 scaleOperator,
 hflipOperator,
 vflipOperator,
 transposeOperator,
 negateOperator,
 splitOperator,
 nullsinkOperator,
 hstackOperator,
 vstackOperator,
 cropOperator,
 setsarOperator,
 setdarOperator,
 setptsOperator,
 copyOperator,
 ilOperator,
 fieldOperator,
 epxOperator,
 swapuvOperator,
 limiterOperator,
 pixelizeOperator,
 shuffleplanesOperator,
 chromashiftOperator,
 erosionOperator,
 dilationOperator,
 deflateOperator,
 inflateOperator,
 fillbordersOperator,
 swaprectOperator,
] as const);
type Operator=typeof videoOperators[number];
type Steps=Operator extends infer O?O extends VideoOperatorDescriptor<infer S,infer T>?{readonly scoped:S;readonly timed:T}:never:never;
/** Configurations of the scoped parser (linear chains, frame graphs, replay streams). */
export type StaticVideoStep=Steps['scoped'];
/** Configurations of the activation parser (timed planner, actors, timed executor). */
export type TimedVideoStep=Steps['timed'];
export type VideoOperatorName=Operator['name'];
/** Runtime pseudo nodes of the timed planner; never operator names. */
const reserved=new Set(['source','sink','trim']),roles:readonly VideoOperatorRole[]=['identity','fanout','sink','resize','frame','join','retime'],sized:readonly VideoOperatorRole[]=['resize','frame','join'],frameMembers=['validate','bypass','frame','stageFields','actorFrame'] as const;
const roleRules:Readonly<Record<VideoOperatorRole,readonly VideoExecutionPath[]>>={identity:videoExecutionPaths,fanout:['graph','stream','actor','timed'],sink:['graph','stream','actor','timed'],resize:videoExecutionPaths,frame:videoExecutionPaths,join:['graph','stream','actor','timed'],retime:['actor','timed']};
/** Every flag must have the members its role needs on that path; failures name the descriptor. */
export function validateVideoOperator(op:VideoOperatorDescriptor):void{
 const invalid=(reason:string)=>{throw new Error(`Invalid video operator descriptor ${String(op.name)}: ${reason}`);};
 if(typeof op.name!=='string'||!/^[A-Za-z0-9_]{1,64}$/.test(op.name)||reserved.has(op.name))invalid('name');
 if(!roles.includes(op.role))invalid('role');
 if(!Array.isArray(op.paths)||new Set(op.paths).size!==op.paths.length||op.paths.some(path=>!videoExecutionPaths.includes(path)))invalid('paths');
 for(const path of op.paths){
  if(!roleRules[op.role].includes(path))invalid(`role ${op.role} is not executable on ${path}`);
  const scoped=path==='linear'||path==='graph'||path==='stream';
  if(scoped?!op.parse:!op.parse&&!op.parseTimed)invalid(`no parser for ${path}`);
  if(op.role==='frame'&&!op.frame&&(path!=='actor'||!op.actorFrame))invalid(`no frame function for ${path}`);
  if(op.role==='join'&&(!op.combine||!op.geometry))invalid(`no join functions for ${path}`);
  if(op.role==='resize'&&!op.geometry)invalid(`no resize geometry for ${path}`);
  // Replay streams compile with the frame-graph planner.
  if(path==='stream'&&!op.paths.includes('graph'))invalid('stream requires graph');
 }
 // Members outside their role would run on some paths and not others.
 if((op.geometry||op.timedGeometry)&&!sized.includes(op.role))invalid(`role ${op.role} keeps its input geometry`);
 for(const member of frameMembers)if(op[member]&&op.role!=='frame')invalid(`${member} needs role frame`);
 if(op.combine&&op.role!=='join')invalid('combine needs role join');
 if(!Array.isArray(op.examples)||!op.examples.length||op.examples.some(example=>typeof example!=='string'||!example))invalid('examples');
}
const table=new Map<string,VideoOperatorDescriptor>();
for(const op of videoOperators as readonly VideoOperatorDescriptor[]){validateVideoOperator(op);if(table.has(op.name))throw new Error('Duplicated video operator '+op.name);table.set(op.name,op);}
/** Registry lookup; prototype names such as constructor are never operators. */
export function videoOperator(name:string):VideoOperatorDescriptor|undefined{return table.get(name);}
export function supportsVideoPath(name:string,path:VideoExecutionPath):boolean{return table.get(name)?.paths.includes(path)===true;}
/** Unknown names and registered operators without this path fail explicitly. */
export function requireVideoPath(name:string,path:VideoExecutionPath,failure?:(name:string)=>Error):VideoOperatorDescriptor{
 const op=table.get(name);if(!op?.paths.includes(path))throw failure?failure(name):new Error(`Video filter ${name} is not implemented for ${path} execution`);return op;
}
