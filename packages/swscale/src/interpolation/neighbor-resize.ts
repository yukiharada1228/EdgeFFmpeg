import {createInterpolationResize} from "./interpolated-resize.js";
import {pointAxis,pointAxisBound} from "./point-axis.js";
const methods=createInterpolationResize(pointAxis,pointAxisBound);
export const resizeNeighborVideoFrame=methods.resize;
export const neighborResizeStateBytes=methods.stateBytes;
export {PixelResizeError} from "./interpolated-resize.js";
export type {PixelResizeOptions} from "./interpolated-resize.js";
