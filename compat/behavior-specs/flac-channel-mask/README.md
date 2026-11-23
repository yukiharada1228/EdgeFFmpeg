# FLAC comment channel masks

Finite evidence copied byte-for-byte from the proven private native-channel-masks.json.
SHA-256: a502cc488d3f330678573949e278eeb6d8dc0e4da82c713b013b9e5890553ad3.
Each of 40 small complete FLAC fixtures retains its input hash, Native stdout,
stderr, invocation, tags, and stream layout. No Native processes run during tests.
Reference executable SHA-256: 9cb672fd23da44c9a1fa5cb6f9255eab4ca3ddbba6d8c94a676b719cf0c87698.
Reference: FFmpeg 9.0.2 commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8,
Apple clang 21.0.0, Mac LP64. This does not establish other libc behavior.

Pinned source SHA-256:
- libavformat/flacdec.c: e964305b49d52c76f6876b8c9ec013c0376792d1b64263e9d69f9fa63c81d76c
- libavcodec/flac.c: 23cc2c8d957b48c3513c6a9b65ae587372ea459197aaf1fa099c48714139402c
- libavutil/channel_layout.h: fbd3246297cd72be45268eacd9229d23247dfe394fb15b6a40ce8773422661c6

Native cases establish stereo tag consumption and effective layouts with consistent
STREAMINFO/frame counts. Defaults for counts 3–8 are source-derived controls,
not Native multichannel decoder evidence. Helpers operate on structural borrowed
key/value entries without I/O, owned byte scratch, or metadata parser integration.
Tests compare effects and layouts, not raw comment parsing or frame handling.
