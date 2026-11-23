# Initial CLI execution path

The Core `FFmpeg` frontend accepts an explicit backend and VFS. createMediaBackend is the finite audio/declared-rawvideo factory, with scoped MP4 packet copy; createWavBackend remains an alias. No codec/backend is installed implicitly and there is no native FFmpeg fallback. `createWavBackend()` from `@edge-ffmpeg/avformat` connects the current WAV demux/mux implementations in a sequential stream-copy or explicit PCM encoding path.

```typescript
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';

const filesystem = await createNodeFileSystem({
  root: './media', maxReadBytes: 65536, maxWriteBytes: 65536
});
const ffmpeg = new FFmpeg({ filesystem, backend: createWavBackend() });
const result = await ffmpeg.exec([
  '-n', '-i', '/input.wav', '-c:a', 'copy', '/output.wav'
]);
```

The development launcher bundles the local TypeScript packages in memory and runs this same path, without invoking native FFmpeg:

```sh
npm run ffmpeg -- --root ./media -- -n -i /input.wav -c copy /output.wav
```

Launcher output is JSON and its exit status follows the result. This is not a byte-for-byte recreation of FFmpeg terminal logs.

## Supported audio command subset

- Exactly one input and one output, using absolute virtual filesystem paths.
- Finite PCM WAV or [AIFF/AIFC](aiff-support.md) input; bounded magic detection or explicit `-f wav`/`-f aiff`.
- Explicit output `-c copy` / `-codec copy`, including audio and stream-zero selectors. Last applicable codec option wins. Explicit integer PCM encoders and scoped float sample-format conversions are also supported; see [PCM support](pcm-support.md). WAV now defaults to pcm_s16le; each raw output format defaults to its matching PCM codec.
- Single audio chains via -af / -filter:a support anull and constant volume with float/double precision; see [audio filters](audio-filters.md). Filtering and copy cannot be combined.
- Input/output `-ss`, `-t` and `-to` within the [documented time-selection scope](time-selection.md).
- Optional one `-map` selecting `0`, `0:0`, `0:a` or `0:a:0`.
- WAV output selected by `.wav` extension or `-f wav`; twenty explicitly declared raw formats are also supported. See [raw PCM](raw-pcm.md) for input rate/channels and defaults.
- `-vn`, `-sn`, `-dn` for the nonexistent nonaudio streams; `-hide_banner` is accepted.
- `-cpuflags 0` pins scalar processing and is currently required for float-to-integer output. Other CPU flag expressions are unsupported.
- `-y` requests replacement; `-n` requests no replacement. Both together fail. With neither flag the library uses no replacement, rather than interactive prompting.

Every other parsed option is rejected before opening the input or output. Invalid input is detected before opening the output. Negative/EOF input seeking, general filter graphs, compressed encoding, resampling, loglevel handling, optional/negative/multiple maps, additional streams, compressed containers and network protocols remain unimplemented. This backend does not perform general CLI-to-graph planning or graph scheduling.

`exec` resolves to `{ exitCode, outputs, diagnostics, error? }`. Success reports only committed outputs. Failure preserves the original exception in `error` for recovery, including adapter-specific published/uncertain outcomes; an empty outputs array on failure is not evidence that external side effects were rolled back. Diagnostics/exit behavior are not yet FFmpeg error-compatible. Cancellation is cooperative and passed through to demux/mux.

The default budget is application policy: 64 MiB resident target, 64 KiB buffers, 10 seconds CPU target and eight pending packet slots. These are not observed/enforced runtime CPU or resident-memory measurements. VFS per-operation limits must be at least the configured buffer limit. The initial backend enforces bounded read/write operations, but full allocation accounting, CPU enforcement and aggregate scheduler budgets remain work in progress.

Tests cover unsupported requests before I/O, invalid input, default/no-clobber/overwrite behavior, actual launcher processes, six-codec copy and 16-pair integer conversion native comparisons and workerd execution with R2 input and a tiny test sink. Opt-in persistent R2 output and its failure/recovery tests are described in [R2 output](r2-output.md).

AIFF output is selected by -f aiff or .aif/.aiff/.aifc extensions and defaults to pcm_s16be; see [AIFF/AIFC semantics](aiff-support.md).

A separate explicit [timed video backend](timed-video-backend.md) now provides
bounded finite rawvideo actor execution, crop/aspect handling and stateful scale
expressions through the same public frontend. Select it with
`createTimedVideoBackend`; the audio backend subset above is unchanged.

The explicit timed backend additionally supports ordinary `-vf`/`-filter` video
options, per-output last-applicable selection, scoped automatic finite-rawvideo
selection and present numeric video maps. See the timed backend document for its
canonical corpus, selector bounds, metadata-handle lifetime and unfinished paths.

Finite rawvideo paths additionally implement scoped [streamcopy option/timestamp
handling](video-streamcopy.md) and [signed video time](signed-video-time.md).
The audio subset and remaining runtime/CLI limitations above retain their scope.

Finite rawvideo also accepts scoped [timestamp preservation flags](video-copy-ts.md).
They preserve input packet clocks, distinguish forced decoder initialization and
retain Native automatic synchronization startup behavior. Audio/compressed and
nonzero-origin timestamp modes remain outside this implementation scope.

## Scoped MP4 streamcopy

The backend also executes supported one-input/output MP4 copy commands through
the public container API. Format discovery may require reading input metadata
before rejecting an unsupported media request; invalid static options still fail
before output creation. See [MP4 scope and evidence](mp4-mux.md) for selection,
options, publication behavior and incomplete features. There is no compressed
encoding/decoding or Native fallback in this path.

The scoped MP4 path additionally supports ordered negative maps, input track-ID
selectors and MDHD language selection/preservation. Their Native-specific numeric,
optional and quoting rules are described in [MP4 selection](mp4-selection.md);
this does not add compressed decoding/encoding or general metadata support.
