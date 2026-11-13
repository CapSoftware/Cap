export type InfraVideoState = "uploading" | "processing" | "ready" | "failed";

export const INFRA_VIDEO_STATE_LABELS: Record<InfraVideoState, string> = {
	uploading: "Uploading",
	processing: "Processing",
	ready: "Ready",
	failed: "Failed",
};

export type InfraLocalUpload = "sending" | "sent" | null;

export type InfraVideoDisplayState = InfraVideoState | "unfinished";

export const INFRA_VIDEO_DISPLAY_LABELS: Record<
	InfraVideoDisplayState,
	string
> = {
	...INFRA_VIDEO_STATE_LABELS,
	unfinished: "Upload not finished",
};

// The list a tab holds is older than what the server has just confirmed, so a
// row can still read "uploading" for a moment after its file was accepted.
// Only an upload this tab neither runs nor finished is called unfinished.
export function infraVideoDisplayState(
	state: InfraVideoState,
	local: InfraLocalUpload,
): InfraVideoDisplayState {
	if (state !== "uploading") return state;
	if (local === "sending") return "uploading";
	return local === "sent" ? "processing" : "unfinished";
}

export const INFRA_VIDEO_PAGE_STEP = 50;
export const INFRA_VIDEO_PAGE_MAX = 1000;

export function infraVideoListLimit(
	show: string | string[] | null | undefined,
): number {
	const requested = Number(Array.isArray(show) ? show[0] : show);
	if (!Number.isFinite(requested) || requested <= INFRA_VIDEO_PAGE_STEP) {
		return INFRA_VIDEO_PAGE_STEP;
	}
	const steps = Math.ceil(requested / INFRA_VIDEO_PAGE_STEP);
	return Math.min(INFRA_VIDEO_PAGE_MAX, steps * INFRA_VIDEO_PAGE_STEP);
}

export function infraVideoListPage<T>(
	rows: readonly T[],
	limit: number,
): { rows: T[]; hasMore: boolean; nextLimit: number | null } {
	const hasMore = rows.length > limit;
	return {
		rows: rows.slice(0, limit),
		hasMore,
		nextLimit:
			hasMore && limit < INFRA_VIDEO_PAGE_MAX
				? Math.min(INFRA_VIDEO_PAGE_MAX, limit + INFRA_VIDEO_PAGE_STEP)
				: null,
	};
}

export type InfraVideoListItem = {
	id: string;
	name: string;
	externalUserId: string | null;
	duration: number | null;
	createdAt: Date;
	state: InfraVideoState;
};

export type InfraVideoSize = {
	name: string;
	width: number;
	height: number;
	bytes: number;
};

export type InfraVideoDetail = InfraVideoListItem & {
	width: number | null;
	height: number | null;
	storedBytes: number | null;
	failure: string | null;
	sizes: InfraVideoSize[];
	hlsUrl: string | null;
	mp4Url: string | null;
	posterUrl: string | null;
	shareUrl: string | null;
	embedCode: string | null;
	stillEncoding: boolean;
};

type StateInput = {
	status: string;
	legacy: boolean;
	duration: number | null;
	width: number | null;
};

// Mirrors developerVideoIsReady: a video uploaded before encoding existed has
// no playback id and no processing state, and is ready once it was measured.
export function infraVideoState(video: StateInput): InfraVideoState {
	if (video.status === "ready") return "ready";
	if (video.legacy && video.duration !== null && video.width !== null) {
		return "ready";
	}
	if (video.status === "errored") return "failed";
	if (video.status === "processing") return "processing";
	return "uploading";
}

const ABOUT_THE_FILE =
	/^(This (file|video) |The uploaded file |Video is longer than )/;
const ABOUT_CREDIT = /^Not enough credit /;

export const INFRA_VIDEO_FAILURE_FALLBACK =
	"This video could not be processed. Upload it again, or export it as an MP4 and upload that.";
// All a viewer of the public page is told. A stored reason is written for
// the uploader and says what to do next, which on someone else's site reads
// as an instruction to their visitor, so no reason is passed on at all.
export const INFRA_VIDEO_PUBLIC_FAILURE = "This video is not available.";

// Some stored reasons come from the encoder and are worded for operators, so
// the owner gets only the sentences written for customers.
export function infraVideoFailure(reason: string | null | undefined): string {
	const text = reason?.trim() ?? "";
	return ABOUT_THE_FILE.test(text) || ABOUT_CREDIT.test(text)
		? text
		: INFRA_VIDEO_FAILURE_FALLBACK;
}

type ListRow = StateInput & {
	id: string;
	name: string;
	externalUserId: string | null;
	createdAt: Date;
};

export function toInfraVideoListItem(row: ListRow): InfraVideoListItem {
	return {
		id: row.id,
		name: row.name,
		externalUserId: row.externalUserId,
		duration: row.duration,
		createdAt: row.createdAt,
		state: infraVideoState(row),
	};
}

type PartState = { state: string };

type DetailRow = ListRow & {
	height: number | null;
	storedBytes: number | null;
	errorReason: string | null;
	renditions:
		| readonly { name: string; width: number; height: number; bytes: number }[]
		| null;
	processing: { hls: PartState; mp4: PartState } | null;
};

const UNFINISHED_PARTS = new Set(["pending", "running", "unavailable"]);

const escapeAttribute = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

export function infraVideoEmbedCode(
	embedUrl: string,
	video: { name: string; width: number | null; height: number | null },
): string {
	const measured =
		video.width !== null &&
		video.height !== null &&
		video.width > 0 &&
		video.height > 0;
	const shape = measured ? `${video.width} / ${video.height}` : "16 / 9";
	return `<iframe src="${escapeAttribute(embedUrl)}" title="${escapeAttribute(video.name)}" style="width: 100%; aspect-ratio: ${shape}; border: 0" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
}

export function toInfraVideoDetail(
	row: DetailRow,
	urls: {
		hlsUrl: string | null;
		mp4Url: string | null;
		posterUrl: string | null;
	},
	page: { shareUrl: string; embedUrl: string } | null = null,
): InfraVideoDetail {
	const item = toInfraVideoListItem(row);
	const shared = page !== null && item.state !== "failed";
	return {
		...item,
		width: row.width,
		height: row.height,
		storedBytes: row.storedBytes,
		failure:
			item.state === "failed" ? infraVideoFailure(row.errorReason) : null,
		sizes: (row.renditions ?? []).map((size) => ({
			name: size.name,
			width: size.width,
			height: size.height,
			bytes: size.bytes,
		})),
		hlsUrl: urls.hlsUrl,
		mp4Url: urls.mp4Url,
		posterUrl: urls.posterUrl,
		shareUrl: shared ? page.shareUrl : null,
		embedCode: shared ? infraVideoEmbedCode(page.embedUrl, row) : null,
		stillEncoding:
			item.state === "ready" &&
			row.processing !== null &&
			[row.processing.hls, row.processing.mp4].some((part) =>
				UNFINISHED_PARTS.has(part.state),
			),
	};
}

const REFRESH_FAST_MS = 3_000;
const REFRESH_SLOW_MS = 10_000;
const REFRESH_FAST_FOR_MS = 2 * 60 * 1000;
const REFRESH_FOR_MS = 30 * 60 * 1000;
const UPLOAD_WATCH_MS = 60 * 60 * 1000;

// An upload that has sat for an hour is not going to finish while someone
// watches, so it stops keeping the page awake. Encoding is always watched.
export function infraVideoIsChanging(
	video: Pick<InfraVideoListItem, "state" | "createdAt">,
	now: number,
): boolean {
	if (video.state === "processing") return true;
	return (
		video.state === "uploading" &&
		now - new Date(video.createdAt).getTime() < UPLOAD_WATCH_MS
	);
}

export function infraRefreshDelayMs(watchedForMs: number): number | null {
	if (watchedForMs >= REFRESH_FOR_MS) return null;
	return watchedForMs < REFRESH_FAST_FOR_MS ? REFRESH_FAST_MS : REFRESH_SLOW_MS;
}
