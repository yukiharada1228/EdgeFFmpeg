# Finite audio container mutation checks

`tests/unit/container-fuzz.test.ts` runs with `npm test` and the compatibility
report's unit gate. It exercises the currently implemented WAV, AIFF and AU
parsers; it does not certify FFmpeg error semantics or other container formats.

The deterministic corpus contains 3,306 parser runs. Each format starts with a
small valid file, every truncated prefix, aligned 32-bit field replacements at
zero/one/signed-boundary/all-ones values, and 256 mutations from LCG seed
`0x1258cafe`. Each input runs with read limits of 1, 7 and 32 bytes, while the VFS
also returns short reads. The tests require:

- Every read stays within the physical input and the configured read limit.
- Each run performs at most 512 reads and emits bounded nonempty packets.
- Successful parsing emits exactly the declared media byte count.
- Rejected inputs produce explicit container/raw-PCM error types, including
  resource or unsupported-feature errors, rather than unexpected exceptions.
- Twenty-four header-read cancellation points and three first-packet
  cancellation points propagate the original abort reason.

The read-operation cap catches repeated I/O loops. It is not a CPU watchdog or a
heap measurement, and this small deterministic corpus is not a replacement for
coverage-guided fuzzing, process isolation, a crash corpus, or tests for complex
containers and compressed codecs. Those design requirements remain incomplete.
