/** Every container format the PCM backend routes: one line per format, exported under its -f name, kept in alphabetical order.
 * Probes, extension mapping, listings and lookups never depend on line order: registry-table.ts sorts explicitly.
 * docs/contributing/container-registry.md is the recipe for adding a line.
 */
export {aiff} from './formats/aiff.js';
export {au} from './formats/au.js';
export {framecrc} from './formats/framecrc.js';
export * from './formats/raw-pcm.js';
export {w64} from './formats/w64.js';
export {wav} from './formats/wav.js';
