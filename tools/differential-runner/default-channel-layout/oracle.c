#include <stdio.h>
#include <inttypes.h>
#include "libavutil/channel_layout.h"
int main(void){int first=1;puts("[");for(int n=1;n<=65535;n++){AVChannelLayout layout={0};char name[256];av_channel_layout_default(&layout,n);if(layout.order==AV_CHANNEL_ORDER_NATIVE){if(av_channel_layout_describe(&layout,name,sizeof(name))<0)return 1;printf("%s{\"channels\":%d,\"name\":\"%s\",\"mask\":\"%" PRIu64 "\"}",first?"":",\n",n,name,layout.u.mask);first=0;}av_channel_layout_uninit(&layout);}puts("\n]");return 0;}
