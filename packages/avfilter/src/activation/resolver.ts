import {VideoFilterParseError} from "../video-ops/descriptor.js";
import {videoOperator} from "../video-ops/registry.js";
import type {TimedVideoStep} from "../video-ops/registry.js";
import type {FilterToken,FilterPads} from "../filter-topology.js";
export {filterBoolean} from "../video-ops/options.js";
export type GraphVideoStep=TimedVideoStep&{readonly enableExpression?:string;readonly scaleWidthExpression?:string;readonly scaleHeightExpression?:string;readonly scaleForceOriginalAspectRatio?:0|1|2;readonly scaleForceDivisibleBy?:number;readonly scaleInterpolation?:'bicubic'|'neighbor'|'bilinear'|'area';readonly scaleResetSar?:boolean;readonly scaleEvalMode?:'init'|'frame'};
/** Activation parsing accepts every registered operator; the timed planner and executors check path flags. */
export function resolveVideoFilter(token:FilterToken):FilterPads<GraphVideoStep>{
 const op=videoOperator(token.name);if(!op?.parseTimed&&!op?.parse)throw new VideoFilterParseError('Unsupported video filter');
 return (op.parseTimed?op.parseTimed(token):op.parse!(token)) as FilterPads<GraphVideoStep>;
}
