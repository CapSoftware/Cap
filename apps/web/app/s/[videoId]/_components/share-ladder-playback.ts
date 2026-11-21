export type ShareLadderRendition = {
	name: string;
	width: number;
	height: number;
	bandwidth: number;
};

export type ShareLadderPlayback = {
	masterUrl: string;
	renditions: ShareLadderRendition[];
	source: { width: number; height: number; bitsPerSecond: number };
	switchOnPause: boolean;
};

export type ShareQuality = "auto" | "original" | number;

export type LadderEngine = "hlsjs" | "native";

export type QualityOption = { id: string; label: string };

export const SHARE_QUALITY_KEY = "cap-share-quality";
export const SHARE_THROUGHPUT_KEY = "cap-share-throughput";
export const STALL_SWITCH_MS = 500;
// Longer than the slowest MP4 first frame measured (Safari at 1.6 Mbps,
// 8.7 s). At 2.5 s a 1.6 Mbps line switched before the MP4's own first frame
// and HLS then took longer to start, so the first frame got slower. Weak
// lines are left to the stall rule once a frame is on screen.
export const FIRST_FRAME_SWITCH_MS = 10_000;
export const LINE_HEADROOM = 1.5;
export const REMEMBERED_LINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MEASURE_AHEAD_SECONDS = 10;
export const MEASURE_WINDOW_MS = 10_000;
export const MEASURE_MIN_MS = 1000;
export const WARM_PLAYLIST_MAX_AGE_MS = 30 * 60 * 1000;

export const qualityLabel = (size: { width: number; height: number }) =>
	`${Math.min(size.width, size.height)}p`;

export function parseShareQuality(
	raw: string | null | undefined,
	renditions: readonly ShareLadderRendition[],
): ShareQuality {
	if (raw === "original") return "original";
	if (raw && /^\d{2,5}$/.test(raw)) {
		const height = Number(raw);
		if (renditions.some((rendition) => rendition.height === height)) {
			return height;
		}
	}
	return "auto";
}

export const serializeShareQuality = (quality: ShareQuality) => String(quality);

export function qualityOptions(
	ladder: ShareLadderPlayback,
	includeRenditions: boolean,
): QualityOption[] {
	const options: QualityOption[] = [
		{ id: "auto", label: "Auto" },
		{ id: "original", label: qualityLabel(ladder.source) },
	];
	if (!includeRenditions) return options;
	for (const rendition of ladder.renditions) {
		options.push({
			id: String(rendition.height),
			label: qualityLabel(rendition),
		});
	}
	return options;
}

export const lineIsSlow = (
	bitsPerSecond: number,
	sourceBitsPerSecond: number,
) =>
	sourceBitsPerSecond > 0 &&
	bitsPerSecond < LINE_HEADROOM * sourceBitsPerSecond;

export function parseRememberedLine(
	raw: string | null | undefined,
	now: number,
): number | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const { bitsPerSecond, measuredAt } = parsed as Record<string, unknown>;
		if (typeof bitsPerSecond !== "number" || typeof measuredAt !== "number") {
			return null;
		}
		if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
		if (measuredAt > now || now - measuredAt > REMEMBERED_LINE_MAX_AGE_MS) {
			return null;
		}
		return bitsPerSecond;
	} catch {
		return null;
	}
}

export const serializeRememberedLine = (bitsPerSecond: number, now: number) =>
	JSON.stringify({ bitsPerSecond: Math.round(bitsPerSecond), measuredAt: now });

export const rememberedLineIsSlow = (
	rememberedBitsPerSecond: number | null,
	sourceBitsPerSecond: number,
) =>
	rememberedBitsPerSecond !== null &&
	lineIsSlow(rememberedBitsPerSecond, sourceBitsPerSecond);

export type ThroughputWindow = {
	gainedSeconds: number;
	elapsedMs: number;
	fullyBuffered: boolean;
};

export const throughputWindowDone = (window: ThroughputWindow) =>
	window.fullyBuffered ||
	window.gainedSeconds >= MEASURE_AHEAD_SECONDS ||
	window.elapsedMs >= MEASURE_WINDOW_MS;

export function measuredThroughput(
	window: ThroughputWindow,
	sourceBitsPerSecond: number,
	force = false,
): number | null {
	if (!(sourceBitsPerSecond > 0) || !(window.gainedSeconds > 0)) return null;
	if (!force && !throughputWindowDone(window)) return null;
	if (window.fullyBuffered && window.gainedSeconds < MEASURE_AHEAD_SECONDS) {
		return null;
	}
	if (force && window.elapsedMs < MEASURE_MIN_MS) return null;
	const seconds = Math.max(window.elapsedMs, 250) / 1000;
	return (window.gainedSeconds * sourceBitsPerSecond) / seconds;
}

export function pickLadderEngine(env: {
	isApple: boolean;
	classicMediaSource: boolean;
	managedMediaSource: boolean;
	touchPoints: number;
	nativeHls: boolean;
}): LadderEngine | null {
	const mse = env.classicMediaSource || env.managedMediaSource;
	const hlsJs = env.isApple
		? env.classicMediaSource && env.touchPoints === 0
		: mse;
	if (hlsJs) return "hlsjs";
	if (env.nativeHls) return "native";
	if (mse) return "hlsjs";
	return null;
}

export const isTouchApple = (env: { isApple: boolean; touchPoints: number }) =>
	env.isApple && env.touchPoints > 0;

export const switchesOnViewerPause = (
	ladder: Pick<ShareLadderPlayback, "switchOnPause">,
	env: { isApple: boolean; touchPoints: number },
) => ladder.switchOnPause && isTouchApple(env);

export function levelIndexForHeight(
	levels: readonly { width: number; height: number }[],
	height: number,
): number {
	return levels.findIndex((level) => level.height === height);
}

export function pickStartRendition(
	renditions: readonly ShareLadderRendition[],
	player: { width: number; height: number },
	bitsPerSecond: number | null,
): ShareLadderRendition | null {
	const ranked = [...renditions].sort(
		(a, b) => b.height - a.height || b.width - a.width,
	);
	if (ranked.length === 0) return null;
	let fit = 0;
	for (const [index, rendition] of ranked.entries()) {
		if (rendition.width < player.width && rendition.height < player.height) {
			break;
		}
		fit = index;
	}
	if (bitsPerSecond === null) return ranked[fit] ?? null;
	for (let index = fit; index < ranked.length; index++) {
		const rendition = ranked[index];
		if (rendition && rendition.bandwidth <= bitsPerSecond) return rendition;
	}
	return ranked[ranked.length - 1] ?? null;
}

export type MasterVariant = {
	width: number;
	height: number;
	bandwidth: number;
	uri: string;
};

export function parseMasterVariants(master: string): MasterVariant[] {
	const lines = master.split(/\r?\n/).map((line) => line.trim());
	const variants: MasterVariant[] = [];
	lines.forEach((line, index) => {
		if (!line.startsWith("#EXT-X-STREAM-INF:")) return;
		const uri = lines[index + 1];
		if (!uri || uri.startsWith("#")) return;
		const resolution = /[:,]RESOLUTION=(\d+)x(\d+)/.exec(line);
		variants.push({
			width: Number(resolution?.[1] ?? 0),
			height: Number(resolution?.[2] ?? 0),
			bandwidth: Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0),
			uri,
		});
	});
	return variants;
}

export function parseMasterAudioUri(master: string): string | null {
	for (const raw of master.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/.test(line)) {
			continue;
		}
		const uri = /URI="([^"]+)"/.exec(line)?.[1];
		if (uri) return uri;
	}
	return null;
}

export const isExpiredMediaStatus = (code: number | undefined) =>
	code === 403 || code === 410;
