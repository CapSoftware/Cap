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
): string {
	const resize = size ? `w=${size.width}:h=${size.height}:` : "";
	return [
		`zscale=${resize}tin=${transfer}:pin=bt2020:min=bt2020nc:t=linear:npl=${REFERENCE_WHITE_NITS}`,
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
