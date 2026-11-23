/* Development-only Native BMP oracle. Never linked into runtime packages. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/frame.h"
#include "libavutil/pixfmt.h"
static int frame_buffer(AVCodecContext *context, AVFrame *frame, int flags) {
    (void)flags;
    return av_frame_get_buffer(frame, *(int *)context->opaque);
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int alignment = atoi(argv[1]);
    if (alignment != 8 && alignment != 16 && alignment != 32 && alignment != 64) return 2;
    unsigned char input[65536];
    size_t size = fread(input, 1, sizeof(input), stdin);
    if (ferror(stdin) || !size || size == sizeof(input)) return 3;
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_BMP);
    AVCodecContext *context = avcodec_alloc_context3(codec);
    AVFrame *frame = av_frame_alloc(); AVPacket *packet = av_packet_alloc();
    if (!context || !frame || !packet) return 4;
    context->opaque = &alignment; context->get_buffer2 = frame_buffer; context->thread_count = 1;
    if (avcodec_open2(context, codec, NULL) < 0 || av_new_packet(packet, size) < 0) return 5;
    memcpy(packet->data, input, size);
    if (avcodec_send_packet(context, packet) < 0 || avcodec_receive_frame(context, frame) < 0 || frame->format != AV_PIX_FMT_PAL8) return 6;
    unsigned stride = abs(frame->linesize[0]);
    for (int i = 0; i < 4; i++) putchar((stride >> (8*i)) & 255);
    for (int row = 0; row < frame->height; row++) fwrite(frame->data[0] + row * frame->linesize[0], 1, frame->width, stdout);
    fwrite(frame->data[1], 1, 1024, stdout);
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&context);
    return ferror(stdout) ? 7 : 0;
}
