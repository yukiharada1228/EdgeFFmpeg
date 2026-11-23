#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavutil/avutil.h"
#include "libavutil/frame.h"
#include "libavutil/log.h"
#include "libavutil/mathematics.h"
#define ENC_TIME_BASE_DEMUX -1
#define ENC_TIME_BASE_FILTER -2
enum VideoSyncMethod{VSYNC_PASSTHROUGH,VSYNC_CFR,VSYNC_VFR,VSYNC_VSCFR};
typedef struct {struct {AVRational tb;} dec;} FrameData;
static FrameData frame_data;
static const FrameData *frame_data_c(const AVFrame *f){return &frame_data;}
static AVRational sink_rate;
static AVRational av_buffersink_get_frame_rate(void *p){return sink_rate;}
typedef struct {int type;void *filter;} OutputFilter;
typedef struct {AVRational framerate,framerate_max;enum VideoSyncMethod vsync_method;const AVRational *framerate_supported;int framerate_clip;} FPSConvContext;
typedef struct {OutputFilter ofilter;FPSConvContext fps;AVRational enc_timebase,tb_out;int tb_out_locked;} OutputFilterPriv;
