import {VideoFilterParseError} from './video-ops/descriptor.js';
import {videoOperator} from './video-ops/registry.js';
import type {StaticVideoStep} from './video-ops/registry.js';
import type {FilterToken,FilterPads} from './filter-topology.js';
export type GraphVideoStep=StaticVideoStep;
/** Frame graphs accept registered operators with a scoped parser; planners and executors check path flags. */
export function resolveVideoFilter(token:FilterToken):FilterPads<GraphVideoStep>{
 const op=videoOperator(token.name);if(!op?.parse)throw new VideoFilterParseError('Unsupported video filter');return op.parse(token) as FilterPads<GraphVideoStep>;
}
