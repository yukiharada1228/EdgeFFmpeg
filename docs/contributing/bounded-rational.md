# Bounded rational reduction

`reduceBoundedRational(num, den, max = 2147483647n)` is exported by
`@edge-ffmpeg/avutil`. It implements the pinned `av_reduce` continued-fraction
selection and returns a frozen `{num, den, exact}` record. `exact` reports whether
the reduced fraction fits the bound without approximation. Denominators are
nonnegative; zero denominators represent signed infinity or the indeterminate
`0/0`. Numerator and denominator must be bigint values whose magnitudes are at
most `INT64_MAX`; `max` must be a bigint from 1 through `INT32_MAX`.

`INT64_MIN` is rejected. The upstream signed absolute value at that input is
undefined, and observed host behavior is not a portable compatibility contract.
The API does not replace the existing exact `rational()` normalization helper.
No mutation, I/O or runtime-specific dependency is involved.

Regenerate the host evidence with:

```sh
node tools/differential-runner/bounded-rational/generate-host.mjs
```

The shared builder checks the lock, clean upstream source, reference binaries,
source/library hashes and compiler metadata. Canonical cases, results, provenance
and hashes are stored in `compat/behavior-specs/bounded-rational`. There are 3,173
cases: boundary sign/zero combinations over five bounds and deterministic signed64
inputs. All numerator/denominator/exactness fields are compared through the public
API in Node and local workerd. Workerd fixture bodies are streamed with a 64 KiB
limit and batches are limited to 128 cases.

This is scoped host evidence. It does not establish production Cloudflare
validation, other rational operations, complete resource accounting or full
FFmpeg compatibility. Experimental aspect calculations delegate to this public
kernel; their graph and CLI backend remain separate unfinished work.
