import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CAP_BUNDLE_HEADER_BYTES,
	MAX_CAP_BUNDLE_BYTES,
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";

const COPY_CHUNK_BYTES = 1024 * 1024;

async function readExact(handle: FileHandle, bytes: number, position: number) {
	const data = Buffer.allocUnsafe(bytes);
	let read = 0;
	while (read < bytes) {
		const result = await handle.read(data, read, bytes - read, position + read);
		if (result.bytesRead === 0) {
			throw new Error("Cap project bundle ended unexpectedly");
		}
		read += result.bytesRead;
	}
	return data;
}

export async function extractEditorCapBundle(
	bundlePath: string,
	abortSignal?: AbortSignal,
) {
	const sourceStats = await lstat(bundlePath);
	if (
		!sourceStats.isFile() ||
		sourceStats.size < CAP_BUNDLE_HEADER_BYTES ||
		sourceStats.size > MAX_CAP_BUNDLE_BYTES
	) {
		throw new Error("Invalid Cap project bundle file");
	}
	const source = await open(bundlePath, "r");
	let root: string | null = null;
	try {
		const openedStats = await source.stat();
		if (
			openedStats.size !== sourceStats.size ||
			openedStats.ino !== sourceStats.ino ||
			openedStats.dev !== sourceStats.dev
		) {
			throw new Error("Cap project bundle changed before extraction");
		}
		const header = await readExact(source, CAP_BUNDLE_HEADER_BYTES, 0);
		const manifestLength = readCapBundleManifestLength(header);
		if (manifestLength === null) {
			throw new Error("Invalid Cap project bundle header");
		}
		const manifest = parseCapBundleManifest(
			await readExact(source, manifestLength, CAP_BUNDLE_HEADER_BYTES),
			sourceStats.size,
		);
		if (!manifest) {
			throw new Error("Invalid Cap project bundle manifest");
		}
		if (abortSignal?.aborted) {
			throw new Error("Cap project import canceled");
		}
		root = await mkdtemp(join(tmpdir(), "cap-editor-import-"));
		const projectPath = join(root, "source.cap");
		await mkdir(projectPath, { mode: 0o700 });
		const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
		const dataStart = CAP_BUNDLE_HEADER_BYTES + manifestLength;
		for (const entry of manifest.files) {
			const destinationPath = join(projectPath, entry.path);
			await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
			const destination = await open(destinationPath, "wx", 0o600);
			try {
				let copied = 0;
				while (copied < entry.size) {
					if (abortSignal?.aborted) {
						throw new Error("Cap project import canceled");
					}
					const length = Math.min(buffer.byteLength, entry.size - copied);
					const result = await source.read(
						buffer,
						0,
						length,
						dataStart + entry.offset + copied,
					);
					if (result.bytesRead === 0) {
						throw new Error("Cap project bundle ended unexpectedly");
					}
					await destination.writeFile(buffer.subarray(0, result.bytesRead));
					copied += result.bytesRead;
				}
			} finally {
				await destination.close();
			}
		}
		const finalStats = await source.stat();
		if (
			finalStats.size !== openedStats.size ||
			finalStats.mtimeMs !== openedStats.mtimeMs ||
			finalStats.ctimeMs !== openedStats.ctimeMs
		) {
			throw new Error("Cap project bundle changed during extraction");
		}
		const extractedRoot = root;
		return {
			path: projectPath,
			cleanup: () => rm(extractedRoot, { recursive: true, force: true }),
		};
	} catch (error) {
		if (root) await rm(root, { recursive: true, force: true });
		throw error;
	} finally {
		await source.close();
	}
}
