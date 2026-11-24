# compensationdelay distance-based delay line

The bounded linear audio chain accepts `compensationdelay` from `libavfilter/af_compensationdelay.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`). It delays every channel by the time sound needs to travel a distance at a temperature, and mixes `dry * x[n] + wet * x[n - delay]`. The output has the input's length and timestamps; there is no tail. Provenance is in `packages/avfilter/NOTICE-COMPENSATIONDELAY`.

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -i /input.wav -af 'compensationdelay=cm=33:mm=7:dry=0.3:wet=0.6' /out.wav
```

## Syntax

`compensationdelay`, `compensationdelay=<options>`. Options are `key=value` pairs separated by `:`, or positional values in AVOption order `mm:cm:m:dry:wet:temp`. As in native, a positional value after a named one is refused, and a later value for the same key wins.

| Option | Type | Range | Default | Accepted spelling |
|---|---|---|---|---|
| `mm` | int | 0..10 | 0 | decimal digits |
| `cm` | int | 0..100 | 0 | decimal digits |
| `m` | int | 0..100 | 0 | decimal digits |
| `dry` | double | 0..1 | 0 | `digits[.digits]` or `.digits` |
| `wet` | double | 0..1 | 1 | `digits[.digits]` or `.digits` |
| `temp` | int | -50..50 | 20 | optional `-`, then decimal digits |

Explicit failures, all `AudioFilterError` (`unsupported-filter` on the CLI) before any output is opened:

- native fails too: out-of-range values (`compensationdelay <key> is out of range [<low> - <high>]`), unknown options (`Unsupported compensationdelay option: <name>`), a positional value after a named one, or too many positional values (`Invalid compensationdelay option`);
- native accepts these, but they are not implemented: expressions and exponents (`cm=10+5`, `dry=1e-1`), non-integer values for the integer options, which native rounds (`mm=1.5`), signs on `dry`/`wet`, escaping (`Unsupported compensationdelay <key> value: <value>`), and timeline `enable` (`compensationdelay timeline enable is not implemented`). Runtime commands are not reachable: the chain has no command interface.

## Delay

`delay = (unsigned)((m*100. + cm*1. + mm*.1) * COMP_DELAY_SOUND_FRONT_DELAY(temp) * sample_rate)`, where the macro is evaluated in its own order: `1.85325 * (643.95 * sqrt((temp + 273.15) / 273.15))`, then `* (1000.0 * 100.0) / (60.0 * 60.0)`, then `1.0 /` that. `sqrt` is correctly rounded in both implementations. Examples: `cm=33:mm=7` at 44100 Hz is 43 samples; `m=100:cm=100:mm=10:temp=-50` at 48000 Hz is 16181 samples. The sample rate is the rate at the filter's position, so a preceding `asetrate` applies.

Each sample is written into the ring before the delayed sample is read, so delay 0 reads the current sample (`compensationdelay` alone outputs `x`, since `wet` defaults to 1 and `dry` to 0).

## Negotiation and arithmetic

`formats()` is native's pinned `['dblp']` (`FILTER_SINGLE_SAMPLEFMT(AV_SAMPLE_FMT_DBLP)`). Every input format negotiates to `dblp`; the step converts each frame to `dblp` with `convertAudioFrame` and emits `dblp`. Output to an integer encoder needs `-cpuflags 0`, as every double-to-integer path does. The step is not `transparent`, because `dry`/`wet` change the values.

The mix `dry * sample + wet * buffer[r]` is two double multiplies and an add, unfused. The Linux x86_64 reference build computes it the same way; macOS builds can contract it into an FMA (a wave-select probe matched 7404 of 10000 samples there), so the float-sensitive differential tests run only on Linux x64.

## State and memory

Native's ring is `buf_size` samples, the smallest power of two that is at least `(unsigned)(sample_rate * COMP_DELAY_MAX_DELAY)`. `COMP_DELAY_MAX_DELAY` uses the 50 degree front delay, the shortest, so at colder temperatures `delay` can exceed `buf_size`, and native's unsigned read `(w + buf_size - delay) & mask` then delays by `delay mod buf_size`. This happens at rates where `sample_rate * COMP_DELAY_MAX_DELAY` lies just below a power of two: at 50000 Hz, `m=100:cm=100:mm=10:temp=-50` computes delay 16855 with `buf_size` 16384, and native delays by 471 samples; at 25000 Hz it delays by 235. EdgeFFmpeg reduces the delay modulo native's `buf_size` (`compensationDelayEffectiveSamples`) and holds `effective delay + 1` doubles per channel. Reading at `(w + 1) mod (effective delay + 1)` returns the same sample as native's masked read. The unit test checks this against a transcription of native's ring at 25000, 48000 and 50000 Hz. A differential test compares wrapping delays with native on every platform, using `dry=0:wet=1` copies and non-overlapping `dry=1:wet=1` impulses, which no fused arithmetic can change. `reserve()` declares one output frame plus `(effective delay + 1) * channels * 8` state bytes. A ring larger than the buffer budget fails with `resource-budget` on the PCM CLI path (`Audio filter state exceeds the configured buffer budget`) before output is opened, where native allocates it; the stream itself refuses a ring larger than `maxFrameBytes` (`compensationdelay delay buffer exceeds allocation limit`).

No constraint: every rate, channel count and layout runs as in native. Empty input produces no frames, as in native. Input format changes mid-stream are refused (`compensationdelay requires a stable input format`). Cancellation is observed per frame and per channel.

## Unsupported

- FLAC input: refused before decoding (`FLAC input to compensationdelay requires additional Native evidence`); `flacInput` is not declared.
- Automatic sample-rate conversion around the step (native lists never accept it).
- Timeline `enable`, runtime commands, expressions and the native spellings listed above.

## Evidence

`tests/differential/compensationdelay.test.ts` runs `.build/reference/ffmpeg` at test time and compares bytes:

| Test | Comparisons |
|---|---|
| `matches native framecrc for distances, temperatures, dry/wet mixes, rates and source formats into f64 and s16` (Linux x64) | 600 framecrc: u8/s16/s32/f32/f64 raw input at 8000/44100/48000 Hz, mono and stereo, 9000 samples, pcm_f64le and pcm_s16le, 10 chains (defaults, mm only, every option, temperatures -50/20/50, dry/wet 0/1, 0.3/0.6 and 1/1, delays from 0 to 3995 samples, the longest spanning several input frames, positional shorthand, after `asetnsamples=37:p=0` and before `volume=0.5`) |
| `writes native-identical f64le, s16le and WAV files with the longest delay and output time selection` (Linux x64) | 48 files: s16/f64 input at 44100 Hz stereo, the 16181-sample maximum-distance delay and a 3 m delay, output `-ss`, `-t`, `-frames:a`, into f64le, s16le and WAV |
| `matches native delays that wrap the power-of-two ring at 25000 and 50000 Hz, with exact dry/wet copies on every platform` | 30 framecrc: s16le and f64le input at 25000, 50000 and 8000 Hz, mono and stereo, delays at temp -50, -45 and -40 that wrap native's ring (471, 106 and 235 samples, for example), after `asetnsamples=997:p=0`, into pcm_s16le and pcm_f64le |
| `matches native output for empty input` | 2 framecrc |
| `refuses unsupported options before output, with native status for each case` | 14 native exit statuses (9 refused by native, 5 accepted by native), all refused here before output |
| `refuses a ring beyond the buffer budget before output, where native allocates it` | 1 native exit status; `resource-budget` here |

`tests/unit/compensationdelay.test.ts` covers parsing with exact messages, the delay table against a transcription of the macros, negotiation for all ten input formats, counts, packet sections, planned reservations and the PCM budget refusal, output against a transcription of native's power-of-two ring with ring wraps and four frame splits (bit-exact, `-0` included), delays reduced modulo native's ring at 25000 and 50000 Hz with three more frame splits, timestamps, ownership, allocation limits and abort.

## Test contracts

| File | Test title | Scope |
|---|---|---|
| `tests/differential/compensationdelay.test.ts` | `matches native framecrc for distances, temperatures, dry/wet mixes, rates and source formats into f64 and s16` | Linux x64 differential |
| `tests/differential/compensationdelay.test.ts` | `writes native-identical f64le, s16le and WAV files with the longest delay and output time selection` | Linux x64 differential |
| `tests/differential/compensationdelay.test.ts` | `matches native delays that wrap the power-of-two ring at 25000 and 50000 Hz, with exact dry/wet copies on every platform` | differential |
| `tests/differential/compensationdelay.test.ts` | `matches native output for empty input` | differential |
| `tests/differential/compensationdelay.test.ts` | `refuses unsupported options before output, with native status for each case` | differential |
| `tests/differential/compensationdelay.test.ts` | `refuses a ring beyond the buffer budget before output, where native allocates it` | differential |
| `tests/unit/compensationdelay.test.ts` | `matches the C transcription across ring wraps, delay 0 and arbitrary frame splits, keeping timestamps and owning output` | unit |
| `tests/unit/compensationdelay.test.ts` | `reduces the delay modulo native's power-of-two ring where colder temperatures exceed it, as the masked read does` | unit |
