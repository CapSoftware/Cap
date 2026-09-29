import { describe, expect, test } from "bun:test";
import {
	EXPORT_FILE_PREFIX,
	exportFileLock,
	holdExportFile,
	newExportFileName,
	removeUnusedExportFiles,
} from "./browser-export-storage";

/// Web Locks as one browser shares them between its tabs: a held name stays
/// held until its callback's promise settles.
function fakeLocks() {
	const held = new Set<string>();
	return {
		held,
		request: (async (
			name: string,
			options: LockOptions | LockGrantedCallback<unknown>,
			callback?: LockGrantedCallback<unknown>,
		) => {
			const run = (callback ?? options) as LockGrantedCallback<unknown>;
			const ifAvailable =
				typeof options === "object" && options.ifAvailable === true;
			if (held.has(name)) {
				if (ifAvailable) return run(null);
				throw new Error("test locks never wait");
			}
			held.add(name);
			try {
				return await run({ name, mode: "exclusive" } as Lock);
			} finally {
				held.delete(name);
			}
		}) as LockManager["request"],
	};
}

function fakeDirectory(names: string[]) {
	const files = new Set(names);
	return {
		files,
		async *keys() {
			yield* [...files];
		},
		async removeEntry(name: string) {
			if (!files.delete(name)) throw new Error("NotFoundError");
		},
	};
}

describe("export file names", () => {
	test("are unique and carry the export prefix", () => {
		const a = newExportFileName(1);
		const b = newExportFileName(1);
		expect(a.startsWith(EXPORT_FILE_PREFIX)).toBe(true);
		expect(a.endsWith(".mp4")).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe("removeUnusedExportFiles", () => {
	test("removes left-over exports nothing holds", async () => {
		const locks = fakeLocks();
		const root = fakeDirectory([
			"cap-export-1.mp4",
			"cap-export-2.mp4",
			"notes.txt",
		]);
		const removed = await removeUnusedExportFiles(root, locks);
		expect(removed.sort()).toEqual(["cap-export-1.mp4", "cap-export-2.mp4"]);
		expect([...root.files]).toEqual(["notes.txt"]);
	});

	test("keeps an export another tab is writing, downloading or uploading", async () => {
		const locks = fakeLocks();
		const root = fakeDirectory(["cap-export-live.mp4", "cap-export-old.mp4"]);
		const release = await holdExportFile("cap-export-live.mp4", locks);
		expect(locks.held.has(exportFileLock("cap-export-live.mp4"))).toBe(true);
		expect(await removeUnusedExportFiles(root, locks)).toEqual([
			"cap-export-old.mp4",
		]);
		expect([...root.files]).toEqual(["cap-export-live.mp4"]);
		release?.();
		await Promise.resolve();
		expect(await removeUnusedExportFiles(root, locks)).toEqual([
			"cap-export-live.mp4",
		]);
		expect(root.files.size).toBe(0);
	});

	test("removes nothing without Web Locks, since nothing shows a file is unused", async () => {
		const root = fakeDirectory(["cap-export-1.mp4"]);
		expect(await removeUnusedExportFiles(root, null)).toEqual([]);
		expect(await holdExportFile("cap-export-1.mp4", null)).toBeNull();
		expect(root.files.size).toBe(1);
	});

	test("carries on past a file that can't be removed", async () => {
		const locks = fakeLocks();
		const root = fakeDirectory(["cap-export-a.mp4", "cap-export-b.mp4"]);
		const remove = root.removeEntry.bind(root);
		root.removeEntry = async (name: string) => {
			if (name === "cap-export-a.mp4")
				throw new Error("NoModificationAllowedError");
			return remove(name);
		};
		expect(await removeUnusedExportFiles(root, locks)).toEqual([
			"cap-export-b.mp4",
		]);
		expect([...root.files]).toEqual(["cap-export-a.mp4"]);
	});
});
