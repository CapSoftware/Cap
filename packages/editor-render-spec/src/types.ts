export const ASPECT_RATIO_KEYS = [
	"wide",
	"vertical",
	"square",
	"classic",
	"tall",
] as const;

export type AspectRatioKey = (typeof ASPECT_RATIO_KEYS)[number];

export const ASPECT_RATIO_VALUES: Record<AspectRatioKey, [number, number]> = {
	wide: [16, 9],
	vertical: [9, 16],
	square: [1, 1],
	classic: [4, 3],
	tall: [3, 4],
};

export type RgbTuple = [number, number, number];

export type BackgroundSourceSpec =
	| {
			type: "color";
			value: RgbTuple;
			alpha: number;
	  }
	| {
			type: "gradient";
			from: RgbTuple;
			to: RgbTuple;
			angle: number;
	  }
	| {
			type: "image";
			path: string | null;
	  }
	| {
			type: "wallpaper";
			path: string | null;
	  };

export type AdvancedShadowSpec = {
	size: number;
	opacity: number;
	blur: number;
};

export type BackgroundCropSpec = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type BackgroundConfigSpec = {
	source: BackgroundSourceSpec;
	padding: number;
	rounding: number;
	roundingType: "rounded" | "squircle";
	crop: BackgroundCropSpec | null;
	shadow: number;
	advancedShadow: AdvancedShadowSpec;
};

export type NormalizedTimelineSegment = {
	start: number;
	end: number;
	timescale: number;
};

export type NormalizedTimelineConfig = {
	segments: NormalizedTimelineSegment[];
};

export type NormalizedRenderConfig = {
	aspectRatio: AspectRatioKey | null;
	background: BackgroundConfigSpec;
	timeline: NormalizedTimelineConfig | null;
	camera?: NormalizedCameraConfig;
};

export type RenderConfigIssue = {
	severity: "error" | "warning";
	code: string;
	path: string;
	message: string;
};

export type NormalizeRenderConfigResult = {
	config: NormalizedRenderConfig;
	issues: RenderConfigIssue[];
};

export type RenderInnerRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type RenderBackgroundSpec = BackgroundSourceSpec;

export type RenderMaskSpec = {
	shape: "roundedRect";
	roundingType: "rounded" | "squircle";
	radiusPx: number;
};

export type RenderShadowSpec = {
	enabled: boolean;
	offsetX: number;
	offsetY: number;
	blurPx: number;
	spreadPx: number;
	alpha: number;
};

export type CameraPositionX = "left" | "center" | "right";
export type CameraPositionY = "top" | "bottom";

export type RenderCameraSpec = {
	position: { x: CameraPositionX; y: CameraPositionY };
	rect: RenderInnerRect;
	rounding: number;
	roundingType: "rounded" | "squircle";
	shadow: RenderShadowSpec;
	mirror: boolean;
};

export type NormalizedCameraConfig = {
	hide: boolean;
	mirror: boolean;
	position: { x: CameraPositionX; y: CameraPositionY };
	size: number;
	rounding: number;
	roundingType: "rounded" | "squircle";
	shadow: number;
	advancedShadow: AdvancedShadowSpec;
};

export type RenderSpec = {
	outputWidth: number;
	outputHeight: number;
	innerRect: RenderInnerRect;
	videoCrop: RenderInnerRect;
	backgroundSpec: RenderBackgroundSpec;
	maskSpec: RenderMaskSpec;
	shadowSpec: RenderShadowSpec;
	cameraSpec?: RenderCameraSpec;
};
