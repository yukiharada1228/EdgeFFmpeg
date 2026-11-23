#include <stdio.h>
#include <stdint.h>
#include "libavformat/isom.h"
int main(void){for(unsigned i=0;i<65536;i++){char language[4];int found=ff_mov_lang_to_iso639(i,language);int encoded=ff_mov_iso639_to_lang(found?language:"und",1);printf("%u %d %u %u %u %u\n",i,found,(uint8_t)language[0],(uint8_t)language[1],(uint8_t)language[2],(uint16_t)encoded);}return 0;}
