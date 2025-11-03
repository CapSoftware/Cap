import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { InternalError } from "./Errors.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { NotFoundError, VerifyVideoPasswordError, VideoId } from "./Video.ts";

export class VideoAnalytics extends Schema.Class<VideoAnalytics>(
	"VideoAnalytics",
)({
	views: Schema.Int,
}) {}

// TODO: Break into enum for page vs watch event
export class VideoCaptureEvent extends Schema.Class<VideoCaptureEvent>(
	"VideoCaptureEvent",
)({
	video: VideoId,
}) {}

export class VideoAnalyticsRpcs extends RpcGroup.make(
	Rpc.make("VideosGetViewCount", {
		payload: Schema.Array(VideoId).pipe(
			Schema.filter((a) => a.length <= 50 || "Maximum of 50 videos at a time"),
		),
		success: Schema.Array(
			Schema.Exit({
				success: Schema.Struct({ count: Schema.Int }),
				failure: Schema.Union(
					NotFoundError,
					PolicyDeniedError,
					VerifyVideoPasswordError, // TODO: Is this correct?
				),
				defect: Schema.Unknown,
			}),
		),
		error: InternalError,
	}),

	Rpc.make("VideosGetAnalytics", {
		payload: VideoId,
		success: VideoAnalytics,
		error: InternalError,
	}),

	Rpc.make("VideosCaptureEvent", {
		payload: VideoCaptureEvent,
		error: InternalError,
	}),
) {}
