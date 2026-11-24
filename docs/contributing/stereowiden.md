# stereowiden

`stereowiden` widens a stereo image with a delayed cross-feed. It adapts
`libavfilter/af_stereowiden.c` at the pinned commit
(`packages/avfilter/NOTICE-STEREOWIDEN`). It is one descriptor,
`packages/avfilter/src/audio/stereowiden.ts`, registered with one line in
`packages/avfilter/src/audio/registry.ts`.

## Syntax

| Option | Shorthand position | Type | Range | Default |
|---|---|---|---|---|
| `delay` | 1 | float, ms | [1, 100] | 20 |
| `feedback` | 2 | float | [0, 0.9] | 0.3 |
| `crossfeed` | 3 | float | [0, 0.8] | 0.3 |
| `drymix` | 4 | float | [0, 1] | 0.8 |

Accepted forms are `stereowiden`, `stereowiden=<delay>[:<feedback>[:<crossfeed>[:<drymix>]]]`,
named `key=value` pairs, and shorthand values followed by named pairs. A
repeated option keeps the last value, as native does. Values are plain decimal
constants (`20`, `.5`, `1.`, `+0.1`, `1.5e1`, `-0`). Like native, each value is
range-checked as a double and then stored as a float.

Refused before any output, with an `AudioFilterError`:

| Input | Message | Native |
|---|---|---|
| a value outside its range (`delay=0.5`, `feedback=0.91`, `crossfeed=-0.1`, `drymix=1.01`) | `stereowiden <key> <value> is out of range [<min> - <max>]` | exit 222 (ERANGE) |
| a shorthand value after a named pair | `No stereowiden option name near '<value>'` | exit 234 |
| a fifth shorthand value | `Too many stereowiden positional options: <value>` | exit 234 |
| an unknown option | `Unsupported stereowiden option: <key>` | exit 8 |
| an SI suffix (`1k` is 1000, which native rejects as out of range) | `Only constant numeric stereowiden <key> values are implemented: <value>` | exit 222 |
| an expression (`2*3`), `nan`, an empty value | `Only constant numeric stereowiden <key> values are implemented: <value>` | `2*3` runs |
| timeline `enable` | `stereowiden timeline enable is not implemented` | runs |

Runtime commands (`asendcmd`, `-filter_complex` commands) are not reachable
from the linear chain, so the runtime flag of feedback, crossfeed and drymix
has no effect.

## Format, layout and rate

`formats()` returns native's list, `['flt']` (packed float). Every input
format (u8, s16, s32, flt, dbl and their planar forms) negotiates `flt`, and
the encoder converts afterwards. The step is not transparent, so the chain's
negotiation guard compares it with the native pick.

`constraint()` accepts only two channels with the layout name `stereo`.
It refuses mono, three or more channels, and two-channel WAV/W64 files whose
extensible mask is not FL+FR, with `stereowiden requires stereo input`. Native
remixes mono and multichannel input implicitly and treats DL+DR as stereo; it
fails for FL+FC.

The ring holds `length = 2*lrintf(delay*sample_rate/1000)` floats. The product
and the division are float operations, and `lrintf` rounds half to even, so
1.5 ms at 1000 Hz gives 2 stereo samples and 2.5 ms gives 2 as well. A length
of 0, for example `delay=1` at 500 Hz, is native's EINVAL from `config_input`
(exit 234). The constraint refuses it with
`stereowiden delay rounds to zero samples at <rate> Hz`.

Automatic sample-rate conversion is refused, as for every native list.
FLAC input is refused before decoding (`FLAC input to stereowiden requires
additional Native evidence`), because the descriptor does not declare
`flacInput`.

## Arithmetic

`stream()` keeps the ring and the write position across frames. Per stereo
sample, in native order:

```text
if cur == length: cur = 0
out0 = fround(fround(fround(d*l) - fround(c*r)) - fround(f*ring[cur+1]))
out1 = fround(fround(fround(d*r) - fround(c*l)) - fround(f*ring[cur]))
ring[cur] = l; ring[cur+1] = r; cur += 2
```

`d`, `c` and `f` are the float drymix, crossfeed and feedback values. This is the
plain float formula that Linux x86-64 evaluates. A macOS build matched only
`fma(-f,x,fma(d,l,-fround(c*r)))`, so the byte comparisons run only on
linux/x64. Output frames keep the input count and timestamps and own new
storage. Input frames are never modified. Finite input cannot produce NaN, and
overflow gives ±infinity, as in C. Non-finite input samples are refused with
`Non-finite stereowiden input is not yet supported`.

## Memory and limits

`reserve()` declares one output frame plus `stateBytes = length*4`, for
example 38,400 bytes for 100 ms at 48000 Hz. The stream refuses a ring larger
than `maxFrameBytes` (`stereowiden delay buffer exceeds allocation limit`), a
sample-rate change between frames, and invalid limits. It checks
`options.signal` once per frame and every 4,096 samples.
`generatesOutput` is false: the filter emits exactly its input count. The chain
derives `reframes` for the stream step, so output `-ss`/`-t` select from the
filtered stream.

## Evidence

- `tests/unit/stereowiden.test.ts` has 6 tests. They cover syntax and exact refusal messages, the
  `lrintf` length (round half to even, float products, zero-length refusal),
  the layout and configured-empty-input constraints, negotiation for every input
  format, the capabilities, `planSamples`, `packetSections` (with an
  `asetnsamples` split), `plannedReservations` and `reservations`, the output
  against a direct transcription of the C loop for 5 option sets × 4 rates × 4
  frame splits (bytes, counts and timestamps), ring wrap-around, ownership,
  allocation and format limits, overflow to infinity, and cancellation.
- `tests/differential/stereowiden.test.ts` runs `.build/reference/ffmpeg`
  (FFmpeg 9.0.2, linux/x64) at test time:
  - 252 framecrc comparisons: delay {1, 20, 100} ms × {8000, 44100, 48000} Hz ×
    option sweeps (4 for s16le and f32le, 2 for u8, s32le and f64le) × pcm_f32le
    and pcm_s16le output, with `-cpuflags 0` and stereo raw input of 6,000
    samples split into many demuxer frames;
  - 182 byte comparisons. Raw s16le at 44100 Hz, raw f32le at 48000 Hz and WAV
    input each run 12 chains: shorthand forms, `asetnsamples` splits before and
    after, two stereowiden steps, volume (float and fixed), apad, and aformat.
    Each chain is compared for f32le and s16le raw output, output `-ss`/`-t`,
    `-frames:a 2` framecrc and s16 framecrc. Two more cases compare whole WAV
    files;
  - 18 refusals. For each one the test asserts native's exit status, our
    non-zero exit, a stereowiden diagnostic and that no output file exists. They
    cover 8 out-of-range values, 3 syntax errors, the zero-length ring, mono,
    three channels, `enable`, an expression, and the FL+FC and DL+DR masks.

## Unsupported

- timeline `enable`, runtime commands, and option expressions or suffixes;
- mono, multichannel and non-default-mask input, which native converts
  implicitly;
- FLAC input;
- non-finite input samples;
- automatic sample-rate conversion inside the chain;
- byte-exact claims off linux/x64, where native may contract the formula into
  fused multiply-adds.

## Proposed test contracts

| id | file | test title | scope |
|---|---|---|---|
| `filter.stereowiden.unit` | `tests/unit/stereowiden.test.ts` | `matches a direct C transcription across options, rates and frame splits, without touching input frames` | stream arithmetic, ring and ownership |
| `filter.stereowiden.syntax` | `tests/unit/stereowiden.test.ts` | `parses shorthand and named float options with native ranges and refuses everything else with exact messages` | parsing |
| `filter.stereowiden.native` | `tests/differential/stereowiden.test.ts` | `matches native framecrc bytes for delay 1/20/100 ms at 8000/44100/48000 Hz across option sweeps, sources and f32/s16 outputs` | linux/x64 byte equality |
| `filter.stereowiden.chains` | `tests/differential/stereowiden.test.ts` | `matches native raw and WAV bytes for shorthand options, asetnsamples splits, composed chains and output time selection` | linux/x64 byte equality |
| `filter.stereowiden.refusals` | `tests/differential/stereowiden.test.ts` | `fails explicitly before output for mono and masked input, native option errors and unimplemented forms` | explicit refusals |
