// Local exports stream into the origin private file system, where a long one
// takes gigabytes. Each file is guarded by a Web Lock for as long as anything
// in the page still needs it (the export writing it, a download reading it,
// an upload); the browser releases the lock when the tab closes or crashes,
// so any file whose lock is free is left over and can go.

export const EXPORT_FILE_PREFIX = "cap-export-";

type LockManagerLike = Pick<LockManager, "request">;

type ExportDirectoryLike = {
	keys(): AsyncIterable<string>;
	removeEntry(name: string): Promise<void>;
};

export function newExportFileName(now = Date.now()) {
	return `${EXPORT_FILE_PREFIX}${now}-${crypto.randomUUID()}.mp4`;
}

export function exportFileLock(name: string) {
	return `cap-export-file:${name}`;
}

function lockManager(): LockManagerLike | null {
	return typeof navigator !== "undefined" && navigator.locks
		? navigator.locks
		: null;
}

/// Holds `name`'s lock until the returned function is called. Resolves once
/// the lock is held; null where Web Locks are unavailable.
export async function holdExportFile(
	name: string,
	locks: LockManagerLike | null = lockManager(),
): Promise<(() => void) | null> {
	if (!locks) return null;
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await new Promise<void>((acquired) => {
		void locks.request(exportFileLock(name), () => {
			acquired();
			return released;
		});
	});
	return release;
}

/// Without Web Locks nothing tells a left-over file from one another tab is
/// using, so only files older than any export or download could run are
/// removed, judged by the time in their name.
const UNLOCKED_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function exportFileCreatedAt(name: string) {
	const digits = /^\d+/.exec(name.slice(EXPORT_FILE_PREFIX.length));
	return digits ? Number(digits[0]) : null;
}

/// Removes every export file no page holds.
export async function removeUnusedExportFiles(
	root: ExportDirectoryLike,
	locks: LockManagerLike | null = lockManager(),
	now = Date.now(),
): Promise<string[]> {
	const names: string[] = [];
	for await (const name of root.keys())
		if (name.startsWith(EXPORT_FILE_PREFIX)) names.push(name);
	const removed: string[] = [];
	if (!locks) {
		for (const name of names) {
			const created = exportFileCreatedAt(name);
			if (created === null || now - created < UNLOCKED_FILE_MAX_AGE_MS)
				continue;
			await root.removeEntry(name).then(
				() => removed.push(name),
				() => undefined,
			);
		}
		return removed;
	}
	for (const name of names) {
		await locks.request(
			exportFileLock(name),
			{ ifAvailable: true },
			async (lock) => {
				if (!lock) return;
				await root.removeEntry(name).then(
					() => removed.push(name),
					() => undefined,
				);
			},
		);
	}
	return removed;
}

export async function exportDirectory() {
	return (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle &
		ExportDirectoryLike;
}
