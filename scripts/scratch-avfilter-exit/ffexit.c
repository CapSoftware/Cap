#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>

static volatile LONG running = 1;
static const char *input;

static void decode_once(void) {
	AVFormatContext *fmt = NULL;
	if (avformat_open_input(&fmt, input, NULL, NULL) < 0) return;
	avformat_find_stream_info(fmt, NULL);
	int index = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
	if (index < 0) { avformat_close_input(&fmt); return; }
	const AVCodec *codec = avcodec_find_decoder(fmt->streams[index]->codecpar->codec_id);
	AVCodecContext *ctx = avcodec_alloc_context3(codec);
	avcodec_parameters_to_context(ctx, fmt->streams[index]->codecpar);
	ctx->thread_count = 0;
	avcodec_open2(ctx, codec, NULL);
	AVPacket *pkt = av_packet_alloc();
	AVFrame *frame = av_frame_alloc();
	int frames = 0;
	while (running && frames < 20 && av_read_frame(fmt, pkt) >= 0) {
		if (pkt->stream_index == index && avcodec_send_packet(ctx, pkt) >= 0) {
			while (avcodec_receive_frame(ctx, frame) >= 0) frames++;
		}
		av_packet_unref(pkt);
	}
	av_frame_free(&frame);
	av_packet_free(&pkt);
	avcodec_free_context(&ctx);
	avformat_close_input(&fmt);
}

static DWORD WINAPI decoder_thread(LPVOID arg) {
	(void)arg;
	while (running) decode_once();
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 5) {
		fprintf(stderr, "usage: ffexit <input.mp4> <threads> <return|join|terminate> <delay-ms>\n");
		return 91;
	}
	input = argv[1];
	int threads = atoi(argv[2]);
	const char *exit_kind = argv[3];
	int delay = atoi(argv[4]);
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
	AVFilterGraph *graph = avfilter_graph_alloc();
	avfilter_graph_free(&graph);
	HANDLE handles[64];
	int started = 0;
	for (; started < threads && started < 64; started++)
		handles[started] = CreateThread(NULL, 0, decoder_thread, NULL, 0, NULL);
	Sleep(delay + GetTickCount() % 50);
	fflush(stdout);
	if (strcmp(exit_kind, "terminate") == 0) TerminateProcess(GetCurrentProcess(), 0);
	if (strcmp(exit_kind, "join") == 0 && started) {
		InterlockedExchange(&running, 0);
		WaitForMultipleObjects(started, handles, TRUE, INFINITE);
	}
	return 0;
}
