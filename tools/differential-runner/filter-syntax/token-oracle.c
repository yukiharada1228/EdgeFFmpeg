#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libavutil/avstring.h"
#include "libavutil/mem.h"
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    long start = strtol(argv[3], NULL, 10);
    size_t length = strlen(argv[1]);
    if (start < 0 || (size_t)start > length) return 2;
    const char *next = argv[1] + start;
    char *token = av_get_token(&next, argv[2]);
    if (!token) return 3;
    printf("%td\n%zu\n", next - argv[1], strlen(token));
    fwrite(token, 1, strlen(token), stdout);
    av_free(token);
    return 0;
}
