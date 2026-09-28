/**
 * New clips are always appended by the import, which then reloads the editor.
 * Where the person asked for the clip is kept here across that reload, then
 * the appended clips are moved into place.
 */
const STORAGE_KEY = "cap-editor-clip-insert";
const MAX_AGE_MS = 30 * 60 * 1000;

type ClipInsert = {
	project: string;
	insertAt: number;
	clipCount: number;
	createdAt: number;
};

export function rememberClipInsert(
	project: string,
	insertAt: number,
	clipCount: number,
) {
	try {
		if (insertAt >= clipCount) {
			sessionStorage.removeItem(STORAGE_KEY);
			return;
		}
		const value: ClipInsert = {
			project,
			insertAt,
			clipCount,
			createdAt: Date.now(),
		};
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {}
}

export function forgetClipInsert() {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {}
}

/** The clips added since the insert was remembered, and where they go. */
export function takeClipInsert(project: string, clipCount: number) {
	let stored: Partial<ClipInsert> | null = null;
	try {
		stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		return null;
	}
	if (
		!stored ||
		stored.project !== project ||
		!Number.isSafeInteger(stored.insertAt) ||
		!Number.isSafeInteger(stored.clipCount) ||
		typeof stored.createdAt !== "number" ||
		Date.now() - stored.createdAt > MAX_AGE_MS
	) {
		return null;
	}
	const insertAt = stored.insertAt as number;
	const previousCount = stored.clipCount as number;
	const added = clipCount - previousCount;
	if (added < 1 || insertAt < 0 || insertAt >= previousCount) return null;
	return { from: previousCount, insertAt, added };
}
