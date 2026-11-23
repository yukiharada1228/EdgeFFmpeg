# WAV channel count and layout fallback

Regenerate with `node tools/differential-runner/wav-channel-layout/generate.mjs`.
An optional output directory allows independent repeat generation.

The 72 fixed Native cases combine one/two/three channels, masks 0/1/3/4/0x3ffff/0x40000, zero/four samples, and default/disabled CLI layout guessing. Native ignores an extensible mask when its population differs from the declared channel count. The demux API retains the count and reports an unspecified layout; CLI input policy can then infer the default layout. Guessing disabled with `-guess_layout_max 0` leaves that layout unspecified.

Tests verify source/artifact/fixture hashes, demux masks and complete serialized output bytes. All72cases also run through independent actual Node launcher processes with full output/status/diagnostic/publication-path checks. These cases do not certify arbitrary layouts or general WAV compatibility. The original 18-case exploratory failure and repaired comparison remain in separate build audit reports.
