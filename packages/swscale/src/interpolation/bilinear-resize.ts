import {createInterpolationResize} from "./interpolated-resize.js";
import {bilinearAxis,bilinearAxisBound} from "./bilinear-axis.js";
const methods=createInterpolationResize(bilinearAxis,bilinearAxisBound);
export const resizeBilinearVideoFrame=methods.resize;
export const bilinearResizeStateBytes=methods.stateBytes;
export {PixelResizeError} from "./interpolated-resize.js";
export type {PixelResizeOptions} from "./interpolated-resize.js";
