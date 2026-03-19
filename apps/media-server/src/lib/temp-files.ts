import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR = join(tmpdir(), "cap-media-server");
const STALE_FILE_AGE_MS = 60 * 60 * 1000;

export interface TempFileHandle {
	path: string;
	cleanup: () => Promise<void>;
}

export async function ensureTempDir(): Promise<void> {
	await mkdir(TEMP_DIR, { recursive: true });
}

export async function createTempFile(
	extension: string,
): Promise<TempFileHandle> {
	await ensureTempDir();
	const filename = `${randomUUID()}${extension.startsWith(".") ? extension : `.${extension}`}`;
	const path = join(TEMP_DIR, filename);

	return {
		path,
		cleanup: async () => {
			try {
				await unlink(path);
			} catch {}
		},
	};
}

export async function cleanupStaleTempFiles(): Promise<number> {
	try {
		await ensureTempDir();
		const files = await readdir(TEMP_DIR);
		const now = Date.now();
		let cleaned = 0;

		for (const file of files) {
			const filePath = join(TEMP_DIR, file);
			try {
				const fileStat = await stat(filePath);
				if (now - fileStat.mtimeMs > STALE_FILE_AGE_MS) {
					await rm(filePath, { force: true });
					cleaned++;
				}
			} catch {}
		}

		return cleaned;
	} catch {
		return 0;
	}
}

export function getTempDir(): string {
	return TEMP_DIR;
}
