// HDR video (what recent phones record by default) carries more brightness and
// a wider colour range than an ordinary screen shows. Encoded as it is into
// 8-bit H.264 it plays grey and flat, so it is converted to standard range
// first.

export type HdrTransfer = "smpte2084" | "arib-std-b67";

const HDR_TRANSFERS: readonly string[] = ["smpte2084", "arib-std-b67"];

export function hdrTransferFrom(
	colorTransfer: string | null,
): HdrTransfer | null {
	return colorTransfer !== null && HDR_TRANSFERS.includes(colorTransfer)
		? (colorTransfer as HdrTransfer)
		: null;
}

// The colour primaries and matrix a source declares, as ffprobe names them.
export interface HdrColor {
	primaries?: string | null;
	matrix?: string | null;
}

// ffprobe and zscale share these names. Anything else (untagged, reserved, or
// a value zscale cannot read) is treated as BT.2020, which is what HDR video
// is mastered in when it says nothing.
const ZSCALE_PRIMARIES: readonly string[] = [
	"bt709",
	"bt470m",
	"bt470bg",
	"smpte170m",
	"smpte240m",
	"film",
	"bt2020",
	"smpte428",
	"smpte431",
	"smpte432",
	"ebu3213",
];
const ZSCALE_MATRICES: readonly string[] = [
	"bt709",
	"fcc",
	"bt470bg",
	"smpte170m",
	"smpte240m",
	"ycgco",
	"bt2020nc",
	"bt2020c",
	"chroma-derived-nc",
	"chroma-derived-c",
	"ictcp",
];
const DEFAULT_HDR_PRIMARIES = "bt2020";
const DEFAULT_HDR_MATRIX = "bt2020nc";

function declared(
	value: string | null | undefined,
	known: readonly string[],
): string | null {
	return value && known.includes(value) ? value : null;
}

// HDR reference white is 203 nits and standard range white is 100, so light is
// scaled to put the two on top of each other: skin, walls and paper keep the
// brightness they would have had in a standard range recording.
const REFERENCE_WHITE_NITS = 203;
// Brighter than that is highlight. Phones master to about 1,000 nits.
const PEAK = 1000 / REFERENCE_WHITE_NITS;
// Everything up to 30% of white passes through untouched, and what is above
// is rolled off smoothly into the top of the range.
const TONE_CURVE = `tonemap=tonemap=mobius:param=0.3:peak=${PEAK.toFixed(2)}:desat=0`;

// The conversion runs on the CPU in linear light and is the slow part of an HDR
// encode, so the picture is first brought down to the size that will be encoded.
export function hdrToSdrFilter(
	transfer: HdrTransfer,
	size?: { width: number; height: number },
	color?: HdrColor | null,
): string {
	const resize = size ? `w=${size.width}:h=${size.height}:` : "";
	const declaredPrimaries = declared(color?.primaries, ZSCALE_PRIMARIES);
	const primaries = declaredPrimaries ?? DEFAULT_HDR_PRIMARIES;
	const matrix = declared(color?.matrix, ZSCALE_MATRICES) ?? DEFAULT_HDR_MATRIX;
	// Frames of a source that declares no primaries carry none, and zscale
	// refuses to convert to "unspecified" ("no path between colorspaces"), so
	// the primaries of its output are named as well.
	const outputPrimaries =
		color && declaredPrimaries === null ? `:p=${primaries}` : "";
	return [
		`zscale=${resize}tin=${transfer}:pin=${primaries}${outputPrimaries}:min=${matrix}:t=linear:npl=${REFERENCE_WHITE_NITS}`,
		"format=gbrpf32le",
		"zscale=p=bt709",
		TONE_CURVE,
		"zscale=t=bt709:m=bt709:r=tv",
		"format=yuv420p",
	].join(",");
}

export const SDR_COLOR_ARGS = [
	"-color_primaries",
	"bt709",
	"-color_trc",
	"bt709",
	"-colorspace",
	"bt709",
	"-color_range",
	"tv",
];
