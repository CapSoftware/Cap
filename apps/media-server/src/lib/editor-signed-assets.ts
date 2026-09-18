import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchMedia } from "./media-transfer";

export type SignedEditorAsset = {
	path: string;
	name: string;
	url: string;
	size: number;
	contentType: string;
	objectIdentity?: string | null;
};

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

export async function stageSignedEditorAsset<T extends Record<string, unknown>>(
	projectPath: string,
	asset: SignedEditorAsset,
	probe: (path: string) => Promise<T>,
	abortSignal?: AbortSignal,
	downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
) {
	if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1000) {
		throw new Error("Invalid editor asset timeout");
	}
	const destination = join(projectPath, asset.path);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const existing = await lstat(destination).catch(() => null);
	if (existing) {
		if (!existing.isFile() || existing.size !== asset.size) {
			throw new Error("Imported editor asset changed");
		}
		return {
			path: asset.path,
			name: asset.name,
			...(await probe(destination)),
		};
	}
	const handle = await open(destination, "wx", 0o600);
	let closed = false;
	try {
		const response = await fetchMedia(asset.url, {
			headers: asset.objectIdentity
				? { "If-Match": asset.objectIdentity }
				: undefined,
			signal: abortSignal
				? AbortSignal.any([abortSignal, AbortSignal.timeout(downloadTimeoutMs)])
				: AbortSignal.timeout(downloadTimeoutMs),
			redirect: "manual",
		});
		if (!response.ok || !response.body) {
			throw new Error(`Editor asset download failed: ${response.status}`);
		}
		const length = response.headers.get("content-length");
		if (length && Number(length) !== asset.size) {
			throw new Error("Editor asset size changed before download");
		}
		const identity = response.headers.get("etag");
		if (identity && asset.objectIdentity && identity !== asset.objectIdentity) {
			throw new Error("Editor asset identity changed before download");
		}
		let received = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > asset.size) {
					throw new Error("Editor asset exceeded expected size");
				}
				await handle.writeFile(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		if (received !== asset.size) {
			throw new Error("Editor asset download was incomplete");
		}
		await handle.sync();
		await handle.close();
		closed = true;
		return {
			path: asset.path,
			name: asset.name,
			...(await probe(destination)),
		};
	} catch (error) {
		if (!closed) await handle.close();
		await rm(destination, { force: true });
		throw error;
	}
}
