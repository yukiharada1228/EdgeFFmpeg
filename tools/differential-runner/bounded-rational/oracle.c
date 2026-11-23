/* SPDX-License-Identifier: LGPL-2.1-or-later */
#include <stdio.h>
#include <inttypes.h>
#include "libavutil/rational.h"
int main(void){int64_t num,den,max;while(scanf("%"SCNd64" %"SCNd64" %"SCNd64,&num,&den,&max)==3){int n,d;int exact=av_reduce(&n,&d,num,den,max);printf("%d %d %d\n",n,d,exact);}return 0;}
