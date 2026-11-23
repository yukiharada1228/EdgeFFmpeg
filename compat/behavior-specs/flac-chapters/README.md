# Vorbis chapter state characterization

The retained `native-chapters.json` is the unchanged finite 20-case private Native capture. SHA-256: `4563bf9c34dbc0af60e373fa1fef50359849da2bd23d1259a43e44548b316d19`. Each short FLAC input is base64 encoded with its own input SHA-256; original command, stdout, stderr and reference binary hash are retained. No large prefix/data recipes are needed for these small fixtures. Native ffprobe binary SHA-256: `9cb672fd23da44c9a1fa5cb6f9255eab4ca3ddbba6d8c94a676b719cf0c87698`.

Source: pinned FFmpeg 9.0.2 commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, `libavformat/oggparsevorbis.c` (`ogm_chapter`), `demux_utils.c` (`avpriv_new_chapter`), and `demux.c` (`compute_chapters_end`). The copied `private-proof.json` preserves historical source hashes and private experiment scope; its paths and test counts describe that prior experiment, not this port's validation.

Native inputs use 257 samples at 8000 Hz (duration 32125 microseconds), zero format start and default probing. Tests replay their ordered decoded comment groups directly into chapter state and compare every chapter descriptor. This is state-level characterization, not a claim of public comment-reader integration or full FLAC compatibility. CUESHEET interaction, format start offsets and inferred/unknown-duration Native parity remain outside scope. Dedicated tests cover the private unknown-duration rule and count limits.

The synchronous state retains bounded chapter records and caller-provided strings. It performs no I/O, asynchronous checkpoints, owned byte allocation or encoded byte copies; abort/read accounting belongs to the comment reader. The default chapter count limit is 1000. Snapshot arrays and descriptors are immutable, and creation order survives end-time computation. `consume`/`finish` and private `accept`/`snapshot` aliases have identical behavior.

Attribution: `oggparsevorbis.c`, Copyright (C) 2005 Michael Ahlberg and Måns Rullgård (MIT); `demux_utils.c` and `demux.c`, Copyright (c) 2000, 2001, 2002 Fabrice Bellard (LGPL-2.1-or-later). Coordinator maintains package notices.
