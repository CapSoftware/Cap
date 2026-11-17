// Stands in for Cap inside an AppImage: it links the bundled FFmpeg the way
// Cap does (so the bundled libva loads with it, or the host's), then connects a
// PipeWire screen-capture stream with Cap's format offer. pw_stream_connect
// loads the host's video converter plugin, which links the host's FFmpeg.
#define _GNU_SOURCE
#include <errno.h>
#include <link.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>

static int print_library(struct dl_phdr_info *info, size_t size, void *data) {
	(void)size;
	(void)data;
	if (strstr(info->dlpi_name, "libva") || strstr(info->dlpi_name, "libavutil"))
		printf("loaded %s\n", info->dlpi_name);
	return 0;
}

// From the bundled libavutil, declared here so no FFmpeg headers are needed.
const char *av_version_info(void);

int main(int argc, char **argv) {
	printf("bundled libavutil %s\n", av_version_info());
	pw_init(&argc, &argv);
	struct pw_thread_loop *loop = pw_thread_loop_new("probe", NULL);
	struct pw_context *context = pw_context_new(pw_thread_loop_get_loop(loop), NULL, 0);
	if (!context) {
		printf("context failed: %s\n", strerror(errno));
		return 1;
	}
	struct pw_core *core = pw_context_connect(context, NULL, 0);
	if (!core) {
		printf("core connect failed: %s\n", strerror(errno));
		return 1;
	}
	struct pw_stream *stream = pw_stream_new(core, "cap-wayland-screen",
		pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture",
			PW_KEY_MEDIA_ROLE, "Screen", NULL));
	uint8_t buffer[1024];
	struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const struct spa_pod *params[1];
	params[0] = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
		SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
		SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
		SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(7, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx,
			SPA_VIDEO_FORMAT_BGRA, SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA, SPA_VIDEO_FORMAT_RGB,
			SPA_VIDEO_FORMAT_BGR),
		SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&SPA_RECTANGLE(1920, 1080),
			&SPA_RECTANGLE(1, 1), &SPA_RECTANGLE(8192, 8192)),
		SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&SPA_FRACTION(30, 1),
			&SPA_FRACTION(0, 1), &SPA_FRACTION(1000, 1)));
	int result = pw_stream_connect(stream, PW_DIRECTION_INPUT, PW_ID_ANY,
		PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS, params, 1);
	printf("LD_LIBRARY_PATH=%s\n", getenv("LD_LIBRARY_PATH") ? getenv("LD_LIBRARY_PATH") : "(unset)");
	dl_iterate_phdr(print_library, NULL);
	printf("pw_stream_connect=%d (%s)\n", result, result < 0 ? strerror(-result) : "ok");
	return result < 0 ? 2 : 0;
}
