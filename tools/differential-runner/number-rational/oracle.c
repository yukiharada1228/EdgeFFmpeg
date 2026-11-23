/* SPDX-License-Identifier: LGPL-2.1-or-later */
#include <stdio.h>
#include <inttypes.h>
#include <string.h>
#include "libavutil/rational.h"
int main(void){uint64_t bits;int max;while(scanf("%"SCNx64" %d",&bits,&max)==2){double d;memcpy(&d,&bits,sizeof(d));AVRational q=av_d2q(d,max);printf("%d %d\n",q.num,q.den);}return 0;}
