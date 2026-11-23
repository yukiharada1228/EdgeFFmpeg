# Bounded FLAC decoder API (partial compatibility)

`createFlacDecoder(module, input, options)` accepts a **trusted, caller-injected compiled**
`WebAssembly.Module`. Production has no Node, filesystem, Native FFmpeg, private
prototype, generated JS glue, or dynamic compilation dependency. Module structural
checks do not establish that arbitrary caller-supplied Wasm is trusted.

The stable wrapper contract is ABI version 1, 29 unsigned info words, Asyncify,
standalone single-threaded fixed 16,777,216-byte linear memory. Required exports:
`memory`, `edge_flac_abi`, `edge_flac_info_words`, `edge_flac_create`,
`edge_flac_destroy`, `edge_flac_step`, `edge_flac_info`, `edge_flac_async_data`, and
Asyncify start/stop unwind/rewind. `_initialize` is optional. Allowed function
imports are `env.edge_host_read` and WASI `proc_exit`, `fd_write`, `fd_read`,
`fd_close`, `fd_seek`; WASI calls always fail. Memory and other imports fail.

Options require `reserveExternalMemory(bytes): () => void`. This capability must
reserve the full resident memory **before** instantiation and return an idempotent
release callback; for Core use `bytes => resources.reserveExternalMemory(bytes)`.
Core shares resident accounting between buffers and external reservations without
allocating placeholder arrays. `maxBufferBytes` limits owned buffers, not Wasm.
This accounting excludes module compilation, runtime overhead, input provider
allocations, and application-held references. It is not measured peak memory.

Input size must fit a nonnegative signed 64-bit integer. Reads are incremental,
bounded, may be short, and must make progress before advertised EOF. Defaults:
65,536 bytes per read, 4,194,304 bytes per frame. Limits, read function, checkpoint,
MD5 policy, reservation callback, and parent signal are captured on creation.
The caller controls cooperative checkpoints; one synchronous Wasm step cannot be
preempted. Never-settling checkpoints and input reads are interruptible. Late
provider resolutions/rejections are observed without copying late bytes to Wasm.

`next()` yields metadata, a frame, or end. Each frame contains immutable metadata,
sample position/count and borrowed **right-justified signed Int32 PCM planes**.
Consumers shift samples left when converting to FFmpeg s16/s32 packed formats.
Call `release()` before `next()`; release is idempotent. Previously obtained array
references must not be used after release or close. Concurrent `next()` rejects.
`close()` is idempotent, interrupts waits, invalidates held frames, and releases
accounting. Parent abort also closes idle decoders. Fatal decode/read/checkpoint
errors close automatically; caller cancellation reasons are preserved.

## Provenance

The TypeScript host adapter is ported from this project's original investigation
adapter, without runtime imports from that investigation. The codec implementation
is Xiph.Org **libFLAC 1.5.0**, BSD-3-Clause; retain libFLAC's upstream copyright and
license notices when distributing the module. The canonical build/provenance owner
maintains the source and wrapper notices; this specification is not a license audit.

- Source: https://downloads.xiph.org/releases/flac/flac-1.5.0.tar.xz
- Source archive SHA256: `f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920`
- Development module: `.build/codecs/flac/edge-flac.wasm`
- Module SHA256: `d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f`
- Native reference FFmpeg n9.0.2 commit: `946fcce07b6dcd0331c8cc609192aeff5e1924f8`
- Native executable SHA256: `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`
- Native evidence platform: Darwin arm64; toolchain reproducibility and target
  platform equivalence are not established by these fixtures.

## Finite evidence and policy gaps

`tests/integration/flac-decoder-native.test.ts` uses saved pinned Native bytes,
checks input/output hashes, and executes the actual canonical Wasm through the
public typed decoder. It does not invoke Native child processes. All 78 clean
cases retain PCM parity (including empty streams, channel/bit-depth variations,
compression/pattern variations and final short frames). This finite corpus does
not prove general FLAC conformance, timestamp parity or Workers deployment safety.

The separate 70-case malformed/profile characterization explicitly retains:

| Observation | Count |
|---|---:|
| PCM matches Native | 48 |
| PCM differs from Native | 22 |
| Completion differs from Native | 31 |
| Cases with unsupported Native CLI policies | 56 |

Native `-xerror`, error-recognition/recovery policies, diagnostics, exit-code
mapping, and output publication are not implemented by this decoder API. The
integration test compares each current result to recorded libFLAC behavior and
independently counts differences from Native; it does not turn those differences
into parity claims. Its baseline is `.build/flac-investigation/malformed-prototype-result.json`;
its Native oracle is hash-bound by that baseline. Missing evidence is a test
failure, not a silently skipped parity gate.

Safe host-side convergence was examined: the stable wrapper reports libFLAC
errors and rejects affected frames before the host can reproduce FFmpeg recovery.
Recovering missing PCM or mapping Native completion policies cannot be achieved
by changing host success labels. Those require a separately reviewed wrapper or
policy implementation with fresh Native evidence. Frame/header CRC checks remain
enabled; there is no CRC bypass. Optional STREAMINFO MD5 checking is separate and
defaults to false, matching the characterized module policy.

Targeted lifecycle coverage includes reservation accounting, ABI rejection,
held-frame close, overlapping calls, stalled checkpoints before/after execution,
provider failure, parent/close cancellation and late input resolution/rejection.
Broader malformed parity, seeking, muxing, encoding, CPU enforcement, measured
aggregate memory, fuzzing, license/release audit and general runtime certification
remain open.
