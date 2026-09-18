import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
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

function assetReceiptPath(projectPath: string, assetPath: string) {
	return join(
		projectPath,
		".editor-asset-receipts",
		`${createHash("sha256").update(assetPath).digest("hex")}.json`,
	);
}

async function fileDigest(path: string) {
	const digest = createHash("sha256");
	for await (const bytes of createReadStream(path)) digest.update(bytes);
	return digest.digest("hex");
}

async function confirmsExistingAsset(
	destination: string,
	receiptPath: string,
	asset: SignedEditorAsset,
) {
	if (!asset.objectIdentity) return false;
	const receiptFile = await lstat(receiptPath).catch(() => null);
	if (!receiptFile?.isFile() || receiptFile.size > 1024) return false;
	let receipt: unknown;
	try {
		receipt = JSON.parse(await readFile(receiptPath, "utf8"));
	} catch {
		return false;
	}
	if (
		typeof receipt !== "object" ||
		receipt === null ||
		!("identity" in receipt) ||
		receipt.identity !== asset.objectIdentity ||
		!("size" in receipt) ||
		receipt.size !== asset.size ||
		!("sha256" in receipt) ||
		typeof receipt.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(receipt.sha256)
	) {
		return false;
	}
	return (await fileDigest(destination).catch(() => null)) === receipt.sha256;
}

async function saveAssetReceipt(
	receiptPath: string,
	identity: string,
	size: number,
	sha256: string,
) {
	const directory = dirname(receiptPath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory()) {
		throw new Error("Invalid editor asset receipt folder");
	}
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify({ identity, size, sha256 }), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, receiptPath);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function stageSignedEditorAssetUnlocked<
	T extends Record<string, unknown>,
>(
	projectPath: string,
	asset: SignedEditorAsset,
	probe: (path: string) => Promise<T>,
	abortSignal?: AbortSignal,
	downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
) {
	const destination = join(projectPath, asset.path);
	const receiptPath = assetReceiptPath(projectPath, asset.path);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const existing = await lstat(destination).catch(() => null);
	if (existing) {
		if (!existing.isFile() || existing.size !== asset.size) {
			throw new Error("Imported editor asset changed");
		}
		if (await confirmsExistingAsset(destination, receiptPath, asset)) {
			return {
				path: asset.path,
				name: asset.name,
				...(await probe(destination)),
			};
		}
		await rm(destination, { force: true });
	}
	const handle = await open(destination, "wx", 0o600);
	const digest = asset.objectIdentity ? createHash("sha256") : null;
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
		if (asset.objectIdentity && identity !== asset.objectIdentity) {
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
				digest?.update(value);
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
		const details = await probe(destination);
		if (asset.objectIdentity && digest) {
			await saveAssetReceipt(
				receiptPath,
				asset.objectIdentity,
				asset.size,
				digest.digest("hex"),
			);
		}
		return {
			path: asset.path,
			name: asset.name,
			...details,
		};
	} catch (error) {
		if (!closed) await handle.close();
		await rm(destination, { force: true });
		throw error;
	}
}

const pendingStages = new Map<string, Promise<void>>();

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
	const previous = pendingStages.get(destination);
	let release = () => undefined;
	const turn = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	pendingStages.set(destination, turn);
	try {
		if (previous) await previous;
		if (abortSignal?.aborted)
			throw new Error("Editor asset staging was canceled");
		return await stageSignedEditorAssetUnlocked(
			projectPath,
			asset,
			probe,
			abortSignal,
			downloadTimeoutMs,
		);
	} finally {
		release();
		if (pendingStages.get(destination) === turn)
			pendingStages.delete(destination);
	}
}
