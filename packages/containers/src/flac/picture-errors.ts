/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flac_picture.c and id3v2.c, Copyright (c) 2001/2003 Fabrice Bellard;
 * libavutil/base64.c, Copyright (c) 2006 Ryan Martell.
 * LGPL-2.1-or-later. Metadata characterization only; no image decoding or full demux claim.
 */
/* SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER. */
export class FlacPictureMetadataError extends Error{constructor(readonly reason:string){super('Invalid FLAC picture: '+reason);this.name='FlacPictureMetadataError';this.reason=reason;}}
export class FlacPictureContinuationRequired extends Error{}
