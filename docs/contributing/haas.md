# haas stereo enhancer

The bounded linear audio chain accepts `haas` and `haas=<options>`, adapted from `libavfilter/af_haas.c` at the pinned commit (provenance in `packages/avfilter/NOTICE-HAAS`). It runs on the PCM CLI paths (WAV, AIFF, AU, W64, raw PCM, framecrc) and through `AudioFilterChain.process`. FLAC input is refused before decoding with `FLAC input to haas requires additional Native evidence`.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'haas=middle_source=side:left_delay=10:right_balance=0.5' -c:a pcm_f64le /wide.wav
```

## Options

All 13 native options, with native names, defaults and ranges:

| Option | Type | Default | Range |
|---|---|---|---|
| `level_in`, `level_out`, `side_gain`, `left_gain`, `right_gain` | double | 1 | 0.015625–64 |
| `middle_source` | `left`, `right`, `mid`, `side` or 0–3 | `mid` | |
| `middle_phase`, `left_phase` | bool | 0 | |
| `right_phase` | bool | 1 | |
| `left_delay` / `right_delay` | double, ms | 2.05 / 2.12 | 0–40 |
| `left_balance` / `right_balance` | double | -1 / 1 | -1–1 |

Options are `:`-separated `key=value` pairs. As in libavfilter, values without a key fill the options positionally in declaration order (`level_in`, `level_out`, `side_gain`, `middle_source`, `middle_phase`, `left_delay`, `left_balance`, `left_gain`, `left_phase`, `right_delay`, `right_balance`, `right_gain`, `right_phase`) until the first named option. A repeated option takes its last value.

Refused before any output is opened (`unsupported-filter`), each with a `haas` message:

- Native refuses these too: an out-of-range value (`Value <v> for haas option <name> out of range [<min> - <max>]`, native exit 222), a boolean outside 0/1 or `auto` (exit 234), `nan` (exit 234), an unknown option (exit 8), a positional value after a named one and a 14th positional value (exit 234).
- Native accepts these, but they are unimplemented: expressions and SI suffixes (`1+1`, `1k`), fractional `middle_source` values (native rounds them), and quoting and escaping. Booleans accept the native names (case-insensitive) and whole base-10 integers; other spellings such as `0.0` are refused with an `Only 0, 1 and boolean names` message (native exits 234 for `0.0` too). `enable` is refused as an unknown option: haas has no timeline support. haas has no `process_command`, and the chain takes no runtime commands, so commands are refused.
- Inputs native would remix implicitly: mono, three or more channels, and a two-channel WAV/W64 input with a non-default mask (for example FL+FC). The constraint accepts only `channels === 2 && channelLayout === 'stereo'`. Native converts mono and 3-channel input to stereo and exits 0; ours refuses.

## Execution

`formats()` is native's `['dbl']`, so every input format negotiates packed `dbl` (`negotiatedSampleFormats` gives `['dbl']` for u8, s16, s32, flt, dbl and their planar forms), and the encoder converts afterwards. haas is a stream step: it reframes, allocates one output frame per input frame and keeps the delay ring across frames. Sample counts, frame sizes and timestamps are unchanged; it declares no `count()`.

`config_input` is reproduced exactly: delays are `(uint32_t)(delay * 0.001 * sample_rate)`, the phase signs are `par_phase ? 1 : -1`, and the balance coefficients are `(b + 1) / 2 * g * phase` and `(1.0 - (b + 1) / 2) * g * phase`. The loop follows `filter_frame`: the middle sample from the source, times `level_in`, is written into the ring before the two delayed reads, then optionally negated; `side = ring * side_gain`, `side_l = s0 * bl0 - s1 * bl1`, `side_r = s1 * br1 - s0 * br0`, and `out = (mid + side) * level_out`. No step is fused.

Native's ring is the power of two at least `trunc(sample_rate * 40 * 0.001)`. Ours holds `max(delay) + 1` doubles, with each delay reduced modulo native's ring size first. Where `sample_rate * 40 ms` is itself a power of two (6400, 12800, 25600 Hz), a 40 ms delay therefore reads the sample just written, as native does. `reserve()` declares one frame and the ring as `stateBytes` (`(max(delay) + 1) * 8`). `process` refuses a ring larger than `maxFrameBytes` with `haas delay buffer exceeds allocation limit`, refuses a sample-rate change between frames, and observes `options.signal`.

## Evidence

- `tests/unit/haas.test.ts` (5 tests): exact parse results and refusal messages; delay truncation, modulo reduction and ring sizes at 1, 6400, 8000, 25600, 44100 and 48000 Hz; coefficient derivation; negotiation for every input format; constraint refusals including a masked layout name; `planSamples`, `packetSections`, `plannedReservations` and `reservations`; output equal to a direct transcription of the C loop (native power-of-two ring and uint32 index arithmetic) for 10 option sets at 5 rates under 4 frame splittings (200 comparisons), s16 input conversion, input ownership, allocation limits, empty configured input and cancellation.
- `tests/differential/haas.test.ts` (3 tests) against `.build/reference/ffmpeg`, all output comparisons gated to linux/x64:
  - 489 raw PCM byte comparisons: 21 option sweeps (each `middle_source`, middle and side phases, balances, gains, levels, delays 0/2.05/40 ms and mixed, the positional form) at 8000/44100/48000 Hz, stereo u8/s16/s32/f32/f64 input, into f64 and, for f64 input, the defaults and the positional form, also f32 and s16 output with `-cpuflags 0`;
  - 132 framecrc and raw comparisons: raw and WAV input, `asetnsamples` splits before and after, two haas in series, `volume`/`aformat` neighbours, input `-ss`/`-t`, output `-ss`/`-t`/`-frames:a`, and the ring-wrap rates 1, 100, 6400, 12800, 25600 and 192000 Hz;
  - 21 refusals with native's exit status beside ours (non-zero, nothing written, exact message).

## Unsupported

FLAC input; expressions, SI suffixes and other non-literal values; fractional integer options; quoting/escaping; `enable`; runtime commands; automatic sample-rate conversion next to haas; non-stereo input. Float output is verified only on linux/x64. A wave-select probe on macOS matched 8921 of 10000 cases, so other platforms are not claimed.
