import { Schema } from "effect";

export const AspectRatio = Schema.Literal(
	"wide",
	"vertical",
	"square",
	"classic",
	"tall",
);
export type AspectRatio = typeof AspectRatio.Type;

export const ASPECT_RATIOS = {
	wide: { name: "Wide", ratio: [16, 9] },
	vertical: { name: "Vertical", ratio: [9, 16] },
	square: { name: "Square", ratio: [1, 1] },
	classic: { name: "Classic", ratio: [4, 3] },
	tall: { name: "Tall", ratio: [3, 4] },
} as const;

const RGBTuple = Schema.Tuple(Schema.Number, Schema.Number, Schema.Number);

export const BackgroundSource = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("wallpaper"),
		path: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("image"),
		path: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("color"),
		value: RGBTuple,
		alpha: Schema.optional(Schema.Number),
	}),
	Schema.Struct({
		type: Schema.Literal("gradient"),
		from: RGBTuple,
		to: RGBTuple,
		angle: Schema.optional(Schema.Number),
	}),
);
export type BackgroundSource = typeof BackgroundSource.Type;

export const ShadowConfiguration = Schema.Struct({
	size: Schema.Number,
	opacity: Schema.Number,
	blur: Schema.Number,
});
export type ShadowConfiguration = typeof ShadowConfiguration.Type;

export const BorderConfiguration = Schema.Struct({
	size: Schema.Number,
	color: RGBTuple,
	opacity: Schema.Number,
});
export type BorderConfiguration = typeof BorderConfiguration.Type;

export const BackgroundConfiguration = Schema.Struct({
	source: BackgroundSource,
	blur: Schema.Number,
	padding: Schema.Number,
	rounding: Schema.Number,
	roundingType: Schema.optional(Schema.Literal("rounded", "squircle")),
	inset: Schema.Number,
	crop: Schema.NullOr(
		Schema.Struct({
			x: Schema.Number,
			y: Schema.Number,
			width: Schema.Number,
			height: Schema.Number,
		}),
	),
	shadow: Schema.Number,
	advancedShadow: Schema.NullOr(ShadowConfiguration),
	border: Schema.NullOr(BorderConfiguration),
});
export type BackgroundConfiguration = typeof BackgroundConfiguration.Type;

export const CameraXPosition = Schema.Literal("left", "center", "right");
export const CameraYPosition = Schema.Literal("top", "bottom");
export const CameraShape = Schema.Literal("square", "source");

export const CameraConfiguration = Schema.Struct({
	hide: Schema.Boolean,
	mirror: Schema.Boolean,
	position: Schema.Struct({ x: CameraXPosition, y: CameraYPosition }),
	size: Schema.Number,
	zoomSize: Schema.NullOr(Schema.Number),
	rounding: Schema.Number,
	shadow: Schema.Number,
	advancedShadow: Schema.NullOr(ShadowConfiguration),
	shape: CameraShape,
	roundingType: Schema.optional(Schema.Literal("rounded", "squircle")),
	scaleDuringZoom: Schema.optional(Schema.Number),
});
export type CameraConfiguration = typeof CameraConfiguration.Type;

export const AudioConfiguration = Schema.Struct({
	mute: Schema.Boolean,
	improve: Schema.Boolean,
	volumeDb: Schema.Number,
});
export type AudioConfiguration = typeof AudioConfiguration.Type;

export const CursorType = Schema.Literal("auto", "pointer", "circle");
export const CursorAnimationStyle = Schema.Literal("slow", "mellow", "custom");

export const CursorConfiguration = Schema.Struct({
	hide: Schema.Boolean,
	hideWhenIdle: Schema.Boolean,
	hideWhenIdleDelay: Schema.Number,
	size: Schema.Number,
	type: CursorType,
	animationStyle: CursorAnimationStyle,
	tension: Schema.Number,
	mass: Schema.Number,
	friction: Schema.Number,
	raw: Schema.Boolean,
	motionBlur: Schema.Number,
	useSvg: Schema.Boolean,
	rotationAmount: Schema.optional(Schema.Number),
	baseRotation: Schema.optional(Schema.Number),
	stopMovementInLastSeconds: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CursorConfiguration = typeof CursorConfiguration.Type;

export const TimelineSegment = Schema.Struct({
	recordingSegment: Schema.optional(Schema.Number),
	timescale: Schema.Number,
	start: Schema.Number,
	end: Schema.Number,
});
export type TimelineSegment = typeof TimelineSegment.Type;

export const ZoomMode = Schema.Union(
	Schema.Literal("auto"),
	Schema.Struct({
		manual: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
	}),
);

export const ZoomSegment = Schema.Struct({
	start: Schema.Number,
	end: Schema.Number,
	amount: Schema.Number,
	mode: ZoomMode,
	glideDirection: Schema.optional(
		Schema.Literal("none", "left", "right", "up", "down"),
	),
	glideSpeed: Schema.optional(Schema.Number),
	instantAnimation: Schema.optional(Schema.Boolean),
	edgeSnapRatio: Schema.optional(Schema.Number),
});
export type ZoomSegment = typeof ZoomSegment.Type;

export const TimelineConfiguration = Schema.Struct({
	segments: Schema.Array(TimelineSegment),
	zoomSegments: Schema.Array(ZoomSegment),
	sceneSegments: Schema.optional(
		Schema.Array(
			Schema.Struct({
				start: Schema.Number,
				end: Schema.Number,
				mode: Schema.optional(
					Schema.Literal("default", "cameraOnly", "hideCamera"),
				),
			}),
		),
	),
	maskSegments: Schema.optional(Schema.Array(Schema.Any)),
	textSegments: Schema.optional(Schema.Array(Schema.Any)),
});
export type TimelineConfiguration = typeof TimelineConfiguration.Type;

export const CaptionSettings = Schema.Struct({
	enabled: Schema.Boolean,
	font: Schema.String,
	size: Schema.Number,
	color: Schema.String,
	backgroundColor: Schema.String,
	backgroundOpacity: Schema.Number,
	position: Schema.String,
	italic: Schema.Boolean,
	fontWeight: Schema.Number,
	outline: Schema.Boolean,
	outlineColor: Schema.String,
	exportWithSubtitles: Schema.Boolean,
	highlightColor: Schema.String,
	fadeDuration: Schema.Number,
	lingerDuration: Schema.Number,
	wordTransitionDuration: Schema.Number,
	activeWordHighlight: Schema.Boolean,
});

export const CaptionsData = Schema.Struct({
	segments: Schema.Array(Schema.Any),
	settings: CaptionSettings,
});
export type CaptionsData = typeof CaptionsData.Type;

export const ProjectConfiguration = Schema.Struct({
	aspectRatio: Schema.NullOr(AspectRatio),
	background: BackgroundConfiguration,
	camera: CameraConfiguration,
	audio: AudioConfiguration,
	cursor: CursorConfiguration,
	timeline: Schema.NullOr(TimelineConfiguration),
	captions: Schema.NullOr(CaptionsData),
});
export type ProjectConfiguration = typeof ProjectConfiguration.Type;
