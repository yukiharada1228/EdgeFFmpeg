# Scalar sample-format conversion

`@edge-ffmpeg/swresample` now provides `convertAudioFrame(frame, target, { maxFrameBytes, signal? })` for packed u8, s16, s32, flt and dbl frames and their planar counterparts. It preserves rate, channel count/layout, sample count and PTS and creates independently owned output. It does not change sample rate, mix channels or dither; packed/planar layout conversion is described in [planar audio](planar-audio.md).

Integer depth reduction discards low bits. Integer-to-floating conversion normalizes signed amplitude to [-1,1). Floating precision changes use IEEE rounding through DataView. Same-format copies preserve payload bits. Cross-precision NaN conversion is explicitly unimplemented; infinity precision changes retain their sign.

Float-to-integer conversion uses scalar nearest-even rounding and clamps normalized endpoint +1 to the largest positive integer. Currently accepted values are finite and within [-32768,32768]; values outside normalized amplitude are clipped in this safe scalar range. Non-finite and out-of-range float-to-integer conversion are rejected rather than substituting an unverified result. A later rejected packet causes the WAV mux to abort the staged output. Allocation sizes, planes and dimensions are checked; CPU/resident-memory enforcement remains incomplete.

## Reference dispatch matters

On the local arm64 oracle, float32-to-s16 half-way values can differ between SIMD blocks and the scalar tail. Very large and non-finite values also expose runtime-dependent conversion behavior. This was verified by executing the pinned native binary with default dispatch and with `-cpuflags 0`; it was not inferred from source translation.

The generic format API defines deterministic scalar behavior. The CLI requires explicit `-cpuflags 0` when converting floating input into integer output so that the requested FFmpeg execution profile matches that behavior. Other cpuflags expressions remain unsupported. Integer-to-floating and floating precision changes do not require the flag for the tested finite inputs.

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -n -i /float.wav -c:a pcm_s16le /integer.wav
```

This is a staged implementation toward the full target, not a permanent exclusion of exceptional values or SIMD behavior. Default CPU-dispatch compatibility, non-finite/out-of-range integer conversion and all valid cross-precision NaN payload behavior remain tracked gaps.

## Evidence

The new differential contract covers all 36 source/target PCM codec pairs with scalar dispatch explicitly pinned. Integer fixtures use deterministic packed patterns; floating fixtures include normalized endpoints, half-way rounding cases and finite clipping boundaries at magnitude 32768. Both direct codec output and CLI-generated WAV PCM are compared byte-for-byte. The 28 pairs that do not convert floating input to integers are additionally compared with native default dispatch for these fixtures.

A separate diagnostic asserts scalar rounding for 35 half-way samples and records native default dispatch output in the test log without claiming that profiles match. Existing same-format NaN payload tests remain separate from cross-precision conversion. workerd tests check scalar rounding and an integer-to-float WAV conversion persisted to R2. These contracts do not certify all sample values, CPU architectures or packetization conditions.

A separate [mono/stereo remix operator](channel-remix.md) composes these conversions with channel matrices and explicit scalar arithmetic profiles.

The separate [default double resampling core](resampling.md) changes sample rate with bounded FIR state. It does not change the behavior or scope of convertAudioFrame.
