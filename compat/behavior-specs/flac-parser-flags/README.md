# Bounded FLAC parser flags

`createFlacDescriptorParser` accepts fixed `flags: 0 | 1 | 4096 | 4097`.
Exports `PARSER_FLAG_COMPLETE_FRAMES = 1`, `PARSER_FLAG_USE_CODEC_TS = 4096`.
`parse` adds optional caller `pts`, `dts` (bigint or null) and `pos` (bigint,
-1 unknown). Results add `parserPts`, `parserDts`, `parserPos`,
`timestampOffset`, `parserDuration`, including calls without output.
`codecPts` retains its original meaning as header-derived information.

The four-entry ring, remainder-descriptor suppression, fetch/reset after output,
slot scan ordering, caller units, stale duration and final fixed-block PTS behavior
port pinned FFmpeg parser.c and flac_parser.c. Other flags and mutation of flags
are unsupported. No demux scheduling, timestamp rescaling or decoder is implied.
Existing discovery, graph scoring, CRC, subframe policy and budgets are unchanged.

Complete mode requires `inspectCompleteHeader(request)`: trusted bounded header
inspection equivalent to Native `frame_header_is_valid`, returning null or
`{variable, number, blockSamples}`. It must include header CRC and the existing
subframe validation policy. `maxInspectedBytes` is always 17. This contract permits
safe inspection of caller-owned backing bytes AFTER the declared packet, just as
Native does. A seven-byte packet is not necessarily a seven-byte backing buffer.
Callers must provide accessible backing bytes or explicitly initialized zero
padding before inspecting; a short unpadded slice must never be read out of bounds.
The parser holds no bytes and does not synthesize missing non-EOF backing bytes.
EOF is represented internally by zeros, cannot have a valid header, and skips the
callback. Completeness is caller-declared: every nonempty call produces a packet,
even if inspection returns null. Invalid headers retain the previous duration.
Trusted descriptor numeric domains are checked. Callback errors poison the parser;
busy and close-during-callback behavior match descriptor discovery.

Regenerate with `node tools/differential-runner/flac-parser-flags/generate.mjs`.
32 independent public Native invocations use pinned `.build/reference` staticlibs:
four flags x two call sizes x three caller timestamp schedules, plus four flags
x two short zero-padded backing inputs. Calls include terminal EOF. The backing
for seven-byte declarations is the full immutable input plus 64 zero bytes.
`cases.json` contains bounded traces only; binary and transient inputs live under
`.build/flac-parser-flags`. No old characterization fixtures/generator are changed.
Production code has no Node, Native or `.build` dependency.

Source adaptation is LGPL-2.1-or-later, attributed in parser-timestamps.ts to
Fabrice Bellard and Michael Niedermayer (parser.c, 2003), and in parser.ts /
NOTICE-FLAC-PARSER to FFmpeg's FLAC parser authors. See upstream COPYING.LGPLv2.1.
