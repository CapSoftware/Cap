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
	sessionId: Schema.optional(Schema.String),
	city: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	device: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	os: Schema.optional(Schema.String),
	referrer: Schema.optional(Schema.String),
	referrerUrl: Schema.optional(Schema.String),
	utmSource: Schema.optional(Schema.String),
	utmMedium: Schema.optional(Schema.String),
	utmCampaign: Schema.optional(Schema.String),
	utmTerm: Schema.optional(Schema.String),
	utmContent: Schema.optional(Schema.String),
	watchTimeSeconds: Schema.optional(Schema.Int),
	locale: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	timezone: Schema.optional(Schema.String),
	pathname: Schema.optional(Schema.String),
	href: Schema.optional(Schema.String),
	userAgent: Schema.optional(Schema.String),
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
