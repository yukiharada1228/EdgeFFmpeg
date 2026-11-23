import {createInterpolationResize} from "./interpolated-resize.js";
import {areaAxis,areaAxisBound} from "./area-axis.js";
const methods=createInterpolationResize(areaAxis,areaAxisBound);
export const resizeAreaVideoFrame=methods.resize;
export const areaResizeStateBytes=methods.stateBytes;
export {PixelResizeError} from "./interpolated-resize.js";
export type {PixelResizeOptions} from "./interpolated-resize.js";
