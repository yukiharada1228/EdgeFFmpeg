export interface Option { name: string; value: string | null }
export interface FileContext { url: string; options: Option[] }
export interface ParsedCommand { global: Option[]; inputs: FileContext[]; outputs: FileContext[] }
const globals = new Map<string, boolean>([["-noxerror", false], ["-xerror", false], ["-copyts", false], ["-nocopyts", false], ["-start_at_zero", false], ["-nostart_at_zero", false], ["-filter_complex", true], ["-lavfi", true], ["-hide_banner", false], ["-y", false], ["-n", false], ["-loglevel", true], ["-v", true], ["-cpuflags", true]]);
const flags = new Set(["-bitexact", "-an", "-vn", "-sn", "-dn"]);
const values = new Set(["-acodec", "-metadata", "-map_metadata", "-map_chapters", "-metadata_header_padding", "-fpsmax", "-r", "-fps_mode", "-enc_time_base", "-frames", "-aframes", "-vframes", "-video_size", "-pixel_format", "-framerate", "-s", "-vcodec", "-guess_layout_max", "-fflags", "-c", "-codec", "-f", "-map", "-ss", "-t", "-to", "-b", "-filter", "-vf", "-af", "-preset", "-crf", "-ar", "-ac", "-pix_fmt"]);
export class CliError extends Error {}
/** Initial supported subset. Unknown options fail explicitly until their semantics are implemented. */
export function parseArgv(argv: readonly string[]): ParsedCommand {
  const result: ParsedCommand = { global: [], inputs: [], outputs: [] };
  let pending: Option[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "-i") {
      const url = argv[++i];
      if (url === undefined) throw new CliError("Missing input URL");
      result.inputs.push({ url, options: pending }); pending = []; continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const base = token.split(":")[0]!;
      const globalKey = ['-copyts','-nocopyts','-start_at_zero','-nostart_at_zero'].includes(base) ? base : token;
      const global = globals.has(globalKey);
      if (!global && !flags.has(token) && !values.has(base)) throw new CliError(`Unsupported option: ${token}`);
      const takesValue = global ? globals.get(globalKey)! : !flags.has(token);
      const value = takesValue ? argv[++i] : null;
      if (value === undefined) throw new CliError(`Missing value for ${token}`);
      (global ? result.global : pending).push({ name: token, value });
    } else { result.outputs.push({ url: token, options: pending }); pending = []; }
  }
  if (pending.length) throw new CliError("Trailing options without a file");
  return result;
}
export { parseTimeDuration, TimeSyntaxError } from './time.js';
export { parseFrameLimit, FrameLimitError } from './frame-limit.js';
