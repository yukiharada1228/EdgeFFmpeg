/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flac_picture.c and id3v2.c, Copyright (c) 2001/2003 Fabrice Bellard;
 * libavutil/base64.c, Copyright (c) 2006 Ryan Martell.
 * LGPL-2.1-or-later. Metadata characterization only; no image decoding or full demux claim.
 */
/* SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER. */
export const pictureMimeCodecs=new Map([['image/gif','gif'],['image/jpeg','mjpeg'],['image/jpg','mjpeg'],['image/jxl','jpegxl'],['image/png','png'],['image/tiff','tiff'],['image/bmp','bmp'],['image/webp','webp'],['JPG','mjpeg'],['PNG','png']]);
export const pictureTypes=['Other',"32x32 pixels 'file icon'",'Other file icon','Cover (front)','Cover (back)','Leaflet page','Media (e.g. label side of CD)','Lead artist/lead performer/soloist','Artist/performer','Conductor','Band/Orchestra','Composer','Lyricist/text writer','Recording Location','During recording','During performance','Movie/video screen capture','A bright coloured fish','Illustration','Band/artist logotype','Publisher/Studio logotype'];
export class FlacPictureLimitError extends Error{}
