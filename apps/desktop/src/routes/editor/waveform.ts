import type {
	BackgroundSource,
	ProjectConfiguration,
	WaveformSegment,
	WaveformSource,
	WaveformStyle,
	XY,
} from "~/utils/tauri";

export type {
	WaveformSegment,
	WaveformSource,
	WaveformStyle,
} from "~/utils/tauri";

export const WAVEFORM_MIN_BAR_COUNT = 8;
export const WAVEFORM_MAX_BAR_COUNT = 256;

export const WAVEFORM_STYLES: { value: WaveformStyle; label: string }[] = [
	{ value: "bars", label: "Bars" },
	{ value: "mirrored", label: "Mirrored" },
	{ value: "line", label: "Line" },
	{ value: "dots", label: "Dots" },
];

export const WAVEFORM_SOURCES: { value: WaveformSource; label: string }[] = [
	{ value: "mix", label: "Mix" },
	{ value: "mic", label: "Microphone" },
	{ value: "system", label: "Screen audio" },
];

export const waveformStyleLabel = (style: WaveformStyle) =>
	WAVEFORM_STYLES.find((option) => option.value === style)?.label ?? "Waveform";

export function defaultWaveformSegment(
	start: number,
	end: number,
	track: number,
	overrides: Partial<WaveformSegment> = {},
): WaveformSegment {
	return {
		start,
		end,
		track,
		enabled: true,
		center: { x: 0.5, y: 0.86 },
		size: { x: 0.6, y: 0.16 },
		opacity: 1,
		style: "bars",
		color: "#FFFFFF",
		secondaryColor: null,
		barCount: 64,
		barWidth: 0.6,
		rounding: 1,
		sensitivity: 1,
		smoothing: 0.5,
		source: "mix",
		...overrides,
	};
}

const PLACEMENT_MARGIN = 0.06;

export type WaveformPlacement = "bottom" | "center" | "top" | "fullWidth";

export const WAVEFORM_PLACEMENTS: {
	value: WaveformPlacement;
	label: string;
}[] = [
	{ value: "bottom", label: "Bottom" },
	{ value: "center", label: "Center" },
	{ value: "top", label: "Top" },
	{ value: "fullWidth", label: "Full width" },
];

export function placeWaveform(
	segment: Pick<WaveformSegment, "center" | "size">,
	placement: WaveformPlacement,
): { center: XY<number>; size: XY<number> } {
	const size = { ...segment.size };
	if (placement === "fullWidth") {
		size.x = 1;
		return { center: { x: 0.5, y: segment.center.y }, size };
	}
	const y =
		placement === "bottom"
			? 1 - size.y / 2 - PLACEMENT_MARGIN
			: placement === "top"
				? size.y / 2 + PLACEMENT_MARGIN
				: 0.5;
	return { center: { x: 0.5, y: Math.max(0, Math.min(1, y)) }, size };
}

export function waveformPlacementActive(
	segment: Pick<WaveformSegment, "center" | "size">,
	placement: WaveformPlacement,
) {
	const target = placeWaveform(segment, placement);
	const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
	if (placement === "fullWidth") return close(segment.size.x, 1);
	return (
		close(segment.center.x, target.center.x) &&
		close(segment.center.y, target.center.y)
	);
}

// The free stretch of a lane around `time`, so a new waveform fills the gap it
// was added into (the whole video on an empty lane).
export function waveformGapAt(
	segments: { start: number; end: number }[],
	time: number,
	totalDuration: number,
): { start: number; end: number } | null {
	if (!(totalDuration > 0)) return null;
	let start = 0;
	let end = totalDuration;
	for (const segment of segments) {
		if (segment.start <= time && time < segment.end) return null;
		if (segment.end <= time) start = Math.max(start, segment.end);
		else end = Math.min(end, segment.start);
	}
	return end - start >= Math.min(0.5, totalDuration) ? { start, end } : null;
}

const AUDIO_ONLY_BACKGROUND: BackgroundSource = {
	type: "gradient",
	from: [15, 18, 38],
	to: [58, 38, 96],
	angle: 135,
};

function isPlainBackground(source: BackgroundSource) {
	if (source.type !== "color") return false;
	const [r, g, b] = source.value;
	return (r === g && g === b && (r === 0 || r === 255)) || source.alpha === 0;
}

type AudioOnlyProject = Pick<
	ProjectConfiguration,
	"hideDisplay" | "aspectRatio"
> & {
	background: { source: BackgroundSource };
	timeline?: { waveformSegments?: WaveformSegment[] } | null;
};

export function needsAudioOnlySetup(project: AudioOnlyProject) {
	return (
		!project.hideDisplay &&
		(project.timeline?.waveformSegments?.length ?? 0) === 0
	);
}

// First open of an audio-only recording: hide the (empty) screen and give the
// audio something to look at.
export function applyAudioOnlySetup(
	project: AudioOnlyProject,
	duration: number,
) {
	project.hideDisplay = true;
	project.aspectRatio = "wide";
	if (isPlainBackground(project.background.source))
		project.background.source = { ...AUDIO_ONLY_BACKGROUND };
	if (project.timeline)
		project.timeline.waveformSegments = [
			defaultWaveformSegment(0, duration, 0, {
				style: "mirrored",
				center: { x: 0.5, y: 0.5 },
				size: { x: 0.7, y: 0.36 },
				barCount: 72,
			}),
		];
}
