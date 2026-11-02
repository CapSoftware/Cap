export const HIGHLIGHT_LABEL_MAX_LENGTH = 200;
export const HIGHLIGHTS_PER_VIDEO_LIMIT = 500;

export interface VideoHighlight {
	id: string;
	videoId: string;
	authorId: string;
	timestamp: number;
	label: string | null;
	authorName?: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export function normalizeHighlightLabel(
	label: string | null | undefined,
): string | null {
	if (typeof label !== "string") return null;
	const collapsed = label.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return null;
	return Array.from(collapsed).slice(0, HIGHLIGHT_LABEL_MAX_LENGTH).join("");
}

export function normalizeHighlightTimestamp(
	timestamp: unknown,
	duration?: number | null,
): number | null {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
	if (timestamp < 0) return null;
	const rounded = Math.round(timestamp * 10) / 10;
	if (
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 0
	) {
		return Math.min(rounded, Math.floor(duration * 10) / 10);
	}
	return rounded;
}

export function canManageHighlight({
	viewerId,
	authorId,
	ownerId,
}: {
	viewerId: string | null | undefined;
	authorId: string;
	ownerId: string;
}): boolean {
	if (!viewerId) return false;
	return viewerId === authorId || viewerId === ownerId;
}

export function sortHighlights<T extends { timestamp: number; id: string }>(
	highlights: readonly T[],
): T[] {
	return [...highlights].sort(
		(a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
	);
}

export function formatHighlightTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const ss = secs.toString().padStart(2, "0");
	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${ss}`;
	}
	return `${minutes}:${ss}`;
}

export function highlightDeepLink(pageUrl: string, timestamp: number): string {
	const url = new URL(pageUrl);
	url.searchParams.set("t", Math.max(0, Math.floor(timestamp)).toString());
	url.hash = "";
	return url.toString();
}

export function highlightsAsText(
	highlights: readonly { timestamp: number; label: string | null }[],
	pageUrl?: string,
): string {
	return sortHighlights(
		highlights.map((h, index) => ({ ...h, id: index.toString() })),
	)
		.map((h) => {
			const line = `${formatHighlightTime(h.timestamp)} ${h.label ?? "Highlight"}`;
			return pageUrl
				? `${line} ${highlightDeepLink(pageUrl, h.timestamp)}`
				: line;
		})
		.join("\n");
}
