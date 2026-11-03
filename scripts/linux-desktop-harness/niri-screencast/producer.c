// A screencast producer that shares frames the way niri 26.04 does
// (src/screencasting/pw_utils.rs): BGRx with a MANDATORY modifier offered
// from a list (DONT_FIXATE), fixated to one modifier in a second round,
// DMA-BUF buffers only, flagged READWRITE but not MAPPABLE, maxsize 1, and a
// chunk size of 1. The buffers are memfds, which a consumer maps like a
// LINEAR DMA-BUF. Each frame is a solid colour that steps every frame, so a
// consumer can check what it read.
//
// Prints "node <id>" once the stream is ready, then runs until killed.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/buffers.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>

#define WIDTH 640
#define HEIGHT 360
#define STRIDE (WIDTH * 4)
#define LINEAR 0LL
#define X_TILED 0x0100000000000001LL

struct data {
	struct pw_main_loop *loop;
	struct pw_stream *stream;
	struct spa_hook listener;
	struct spa_source *timer;
	int fixated;
	uint32_t frame;
	int announced;
};

static const struct spa_pod *video_format(struct spa_pod_builder *b, const int64_t *modifiers,
		uint32_t count, int dont_fixate) {
	struct spa_pod_frame object, choice;
	spa_pod_builder_push_object(b, &object, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat);
	spa_pod_builder_add(b, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
		SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
		SPA_FORMAT_VIDEO_format, SPA_POD_Id(SPA_VIDEO_FORMAT_BGRx), 0);
	spa_pod_builder_prop(b, SPA_FORMAT_VIDEO_modifier,
		SPA_POD_PROP_FLAG_MANDATORY | (dont_fixate ? SPA_POD_PROP_FLAG_DONT_FIXATE : 0));
	spa_pod_builder_push_choice(b, &choice, SPA_CHOICE_Enum, 0);
	spa_pod_builder_long(b, modifiers[0]);
	for (uint32_t i = 0; i < count; i++)
		spa_pod_builder_long(b, modifiers[i]);
	spa_pod_builder_pop(b, &choice);
	spa_pod_builder_add(b, SPA_FORMAT_VIDEO_size, SPA_POD_Rectangle(&SPA_RECTANGLE(WIDTH, HEIGHT)),
		SPA_FORMAT_VIDEO_framerate, SPA_POD_Fraction(&SPA_FRACTION(0, 1)),
		SPA_FORMAT_VIDEO_maxFramerate, SPA_POD_CHOICE_RANGE_Fraction(&SPA_FRACTION(60, 1),
			&SPA_FRACTION(1, 1), &SPA_FRACTION(60, 1)), 0);
	return spa_pod_builder_pop(b, &object);
}

static void on_param_changed(void *userdata, uint32_t id, const struct spa_pod *param) {
	struct data *data = userdata;
	if (param == NULL || id != SPA_PARAM_Format)
		return;
	const struct spa_pod_prop *modifier = spa_pod_find_prop(param, NULL, SPA_FORMAT_VIDEO_modifier);
	if (modifier == NULL) {
		fprintf(stderr, "modifier prop missing\n");
		pw_main_loop_quit(data->loop);
		return;
	}
	uint8_t buffer[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	if (modifier->flags & SPA_POD_PROP_FLAG_DONT_FIXATE) {
		uint32_t count, choice;
		const struct spa_pod *values = spa_pod_get_values(&modifier->value, &count, &choice);
		const int64_t *modifiers = SPA_POD_BODY_CONST(values);
		int linear = 0;
		for (uint32_t i = 0; i < count; i++)
			linear |= modifiers[i] == LINEAR;
		if (!linear) {
			fprintf(stderr, "consumer offers no LINEAR modifier\n");
			pw_main_loop_quit(data->loop);
			return;
		}
		const int64_t fixated[] = {LINEAR};
		const struct spa_pod *params[1] = {video_format(&b, fixated, 1, 0)};
		fprintf(stderr, "fixating LINEAR\n");
		pw_stream_update_params(data->stream, params, 1);
		return;
	}
	const struct spa_pod *params[1];
	params[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
		SPA_PARAM_BUFFERS_buffers, SPA_POD_CHOICE_RANGE_Int(8, 2, 16),
		SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
		SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(1 << SPA_DATA_DmaBuf));
	pw_stream_update_params(data->stream, params, 1);
	data->fixated = 1;
	fprintf(stderr, "format fixated\n");
}

static void on_add_buffer(void *userdata, struct pw_buffer *buffer) {
	(void)userdata;
	struct spa_data *d = &buffer->buffer->datas[0];
	if (!(d->type & (1 << SPA_DATA_DmaBuf))) {
		fprintf(stderr, "consumer refused DMA-BUF buffers\n");
		return;
	}
	int fd = memfd_create("fake-niri-dmabuf", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, STRIDE * HEIGHT) < 0) {
		perror("memfd");
		return;
	}
	d->type = SPA_DATA_DmaBuf;
	d->flags = SPA_DATA_FLAG_READWRITE;
	d->fd = fd;
	d->mapoffset = 0;
	d->maxsize = 1;
	d->data = NULL;
	d->chunk->offset = 0;
	d->chunk->stride = STRIDE;
}

static void on_remove_buffer(void *userdata, struct pw_buffer *buffer) {
	(void)userdata;
	close(buffer->buffer->datas[0].fd);
}

static void on_state_changed(void *userdata, enum pw_stream_state old, enum pw_stream_state state,
		const char *error) {
	struct data *data = userdata;
	(void)old;
	fprintf(stderr, "state %s %s\n", pw_stream_state_as_string(state), error ? error : "");
	if (!data->announced && state == PW_STREAM_STATE_PAUSED) {
		printf("node %u\n", pw_stream_get_node_id(data->stream));
		fflush(stdout);
		data->announced = 1;
	}
}

static void on_timeout(void *userdata, uint64_t expirations) {
	struct data *data = userdata;
	(void)expirations;
	if (data->fixated)
		pw_stream_trigger_process(data->stream);
}

static void on_process(void *userdata) {
	struct data *data = userdata;
	struct pw_buffer *buffer = pw_stream_dequeue_buffer(data->stream);
	if (buffer == NULL)
		return;
	struct spa_data *d = &buffer->buffer->datas[0];
	uint8_t *pixels = mmap(NULL, STRIDE * HEIGHT, PROT_READ | PROT_WRITE, MAP_SHARED, d->fd, 0);
	if (pixels != MAP_FAILED) {
		uint8_t level = (uint8_t)(16 + (data->frame * 8) % 224);
		for (int i = 0; i < STRIDE * HEIGHT; i += 4) {
			pixels[i] = level;
			pixels[i + 1] = 0x40;
			pixels[i + 2] = 0x80;
			pixels[i + 3] = 0xff;
		}
		munmap(pixels, STRIDE * HEIGHT);
	}
	d->chunk->offset = 0;
	d->chunk->stride = STRIDE;
	d->chunk->size = 1;
	d->chunk->flags = SPA_CHUNK_FLAG_NONE;
	data->frame++;
	pw_stream_queue_buffer(data->stream, buffer);
}

static const struct pw_stream_events events = {
	PW_VERSION_STREAM_EVENTS,
	.state_changed = on_state_changed,
	.param_changed = on_param_changed,
	.add_buffer = on_add_buffer,
	.remove_buffer = on_remove_buffer,
	.process = on_process,
};

int main(int argc, char **argv) {
	struct data data = {0};
	pw_init(&argc, &argv);
	data.loop = pw_main_loop_new(NULL);
	data.stream = pw_stream_new_simple(pw_main_loop_get_loop(data.loop), "fake-niri-screencast",
		pw_properties_new(PW_KEY_MEDIA_CLASS, "Video/Source", PW_KEY_MEDIA_TYPE, "Video",
			PW_KEY_MEDIA_CATEGORY, "Source", PW_KEY_MEDIA_ROLE, "Screen", NULL),
		&events, &data);
	uint8_t buffer[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const int64_t modifiers[] = {X_TILED, LINEAR};
	const struct spa_pod *params[1] = {video_format(&b, modifiers, 2, 1)};
	if (pw_stream_connect(data.stream, PW_DIRECTION_OUTPUT, PW_ID_ANY,
			PW_STREAM_FLAG_DRIVER | PW_STREAM_FLAG_ALLOC_BUFFERS, params, 1) < 0) {
		fprintf(stderr, "connect failed\n");
		return 1;
	}
	data.timer = pw_loop_add_timer(pw_main_loop_get_loop(data.loop), on_timeout, &data);
	struct timespec interval = {0, 1000000000 / 30};
	pw_loop_update_timer(pw_main_loop_get_loop(data.loop), data.timer, &interval, &interval, false);
	pw_main_loop_run(data.loop);
	return 0;
}
