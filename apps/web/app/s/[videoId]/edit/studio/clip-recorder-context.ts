/** What the editor tells the clip recorder about the project it adds to. */
export type ClipRecorderContext = {
	insertAt: number;
	clips: Array<{ name: string; duration: number; thumbnail: string | null }>;
	/** The frame the new clip follows on from (or leads into, at the start). */
	boundaryFrame: string | null;
};

const MAX_CLIPS = 100;
const MAX_THUMBNAIL_LENGTH = 200_000;

export function parseClipRecorderContext(
	value: unknown,
): ClipRecorderContext | null {
	if (typeof value !== "object" || value === null) return null;
	const { insertAt, clips } = value as Record<string, unknown>;
	if (!Array.isArray(clips) || clips.length > MAX_CLIPS) return null;
	if (
		typeof insertAt !== "number" ||
		!Number.isSafeInteger(insertAt) ||
		insertAt < 0 ||
		insertAt > clips.length
	) {
		return null;
	}
	const image = (candidate: unknown) =>
		typeof candidate === "string" &&
		candidate.length <= MAX_THUMBNAIL_LENGTH &&
		candidate.startsWith("data:image/jpeg;base64,")
			? candidate
			: null;
	const parsed: ClipRecorderContext["clips"] = [];
	for (const clip of clips) {
		if (typeof clip !== "object" || clip === null) return null;
		const { name, duration, thumbnail } = clip as Record<string, unknown>;
		if (
			typeof name !== "string" ||
			name.length > 200 ||
			typeof duration !== "number" ||
			!Number.isFinite(duration) ||
			duration < 0 ||
			duration > 86_400
		) {
			return null;
		}
		parsed.push({ name, duration, thumbnail: image(thumbnail) });
	}
	return {
		insertAt,
		clips: parsed,
		boundaryFrame: image((value as Record<string, unknown>).boundaryFrame),
	};
}
