# Number to bounded rational conversion

`numberToBoundedRational(value, max = 2147483647)` is exported by
`@edge-ffmpeg/avutil`. It adapts pinned FFmpeg `av_d2q`: derive the binary scale from
IEEE exponent bits, round the scaled numerator with `floor(x + 0.5)`, then apply
`reduceBoundedRational`. The result is a frozen `{num, den}` record of bigint fields.
The bound is an integer number from 1 through `INT32_MAX`.

NaN returns `0/0`. Values whose magnitude exceeds `INT32_MAX + 3`, including
infinities, return signed `1/0`. Tiny finite inputs, including negative values,
can round to `0/1`. This follows the reference conversion rather than rejecting
all negative or nonfinite numeric inputs. Non-number inputs and invalid maxima
throw `RangeError`.

Regenerate evidence with:

```sh
node tools/differential-runner/number-rational/generate-host.mjs
```

The registered developer oracle calls actual pinned `av_d2q` with raw IEEE bits.
The shared builder verifies clean upstream, lock, source and library hashes,
reference binaries and compiler metadata. Canonical data and hashes live under
`compat/behavior-specs/number-rational`. All numerator/denominator fields are
compared in Node and local workerd for 14,401 cases: every exponent with both
signs, approximation bounds, deterministic raw bit patterns and threshold,
subnormal, PI, one-third and signed-zero anchors. Fixture input is streamed with
a 64 KiB body cap and batches of at most 128 cases.

This evidence is scoped to the recorded host. It does not certify all rational
operations, production Cloudflare, resources or full FFmpeg compatibility.
