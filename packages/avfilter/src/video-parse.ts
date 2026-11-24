// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped option semantics adapted from pinned FFmpeg avfilter.c and vf_scale.c. See ../NOTICE.
import {VideoFilterParseError} from './video-ops/descriptor.js';
import {videoOperator} from './video-ops/registry.js';
import type {StaticVideoStep} from './video-ops/registry.js';
import type {LinearFilterToken} from './video-syntax.js';
export {VideoFilterParseError};
export type ParsedVideoStep=StaticVideoStep;
/** Linear chains accept registered operators flagged for the linear path; options parse per descriptor. */
export function parseVideoFilterToken(filter:LinearFilterToken):ParsedVideoStep {
 const op=videoOperator(filter.name);if(!op?.parse||!op.paths.includes('linear'))throw new VideoFilterParseError('Unsupported video filter');
 return op.parse(filter).configuration as ParsedVideoStep;
}
