import { describe, expect, it } from "vitest";
import {
	BrowserStudioVault,
	type BrowserStudioVaultBackend,
	BrowserStudioVaultBackpressureError,
	type BrowserStudioVaultChunk,
	type BrowserStudioVaultSession,
	deleteBrowserStudioVaultSession,
	recoverBrowserStudioVaultSessions,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/browser-studio-vault";

type MemoryChunk = {
	index: number;
	blob: Blob;
	metadata: BrowserStudioVaultChunk;
};

class MemoryBrowserStudioVaultBackend implements BrowserStudioVaultBackend {
	private readonly sessions = new Map<string, BrowserStudioVaultSession>();
	private readonly chunks = new Map<string, MemoryChunk[]>();
	private readonly failureAtIndex: number | null;

	constructor(options?: { failureAtIndex?: number | null }) {
		this.failureAtIndex = options?.failureAtIndex ?? null;
	}

	async initialize() {}

	async createSession(session: BrowserStudioVaultSession) {
		this.sessions.set(session.sessionId, this.cloneSession(session));
	}

	async updateSession(session: BrowserStudioVaultSession) {
		this.sessions.set(session.sessionId, this.cloneSession(session));
	}

	async appendChunk(
		session: BrowserStudioVaultSession,
		assetId: string,
		index: number,
		chunk: Blob,
		metadata: BrowserStudioVaultChunk,
	) {
		if (this.failureAtIndex === index) {
			throw new Error(`Failed to persist Browser Studio chunk ${index}`);
		}

		this.sessions.set(session.sessionId, this.cloneSession(session));
		const key = this.chunkKey(session.sessionId, assetId);
		const existingChunks = this.chunks.get(key) ?? [];
		existingChunks.push({ index, blob: chunk, metadata });
		this.chunks.set(key, existingChunks);
	}

	async readChunks(sessionId: string, assetId: string) {
		return [...(this.chunks.get(this.chunkKey(sessionId, assetId)) ?? [])]
			.sort((left, right) => left.index - right.index)
			.map((entry) => entry.blob);
	}

	async listSessions() {
		return [...this.sessions.values()].map((session) =>
			this.cloneSession(session),
		);
	}

	async deleteSession(sessionId: string) {
		this.sessions.delete(sessionId);
		for (const key of this.chunks.keys()) {
			if (key.startsWith(`${sessionId}:`)) {
				this.chunks.delete(key);
			}
		}
	}

	getSessionCount() {
		return this.sessions.size;
	}

	getChunkCount(sessionId: string, assetId: string) {
		return this.chunks.get(this.chunkKey(sessionId, assetId))?.length ?? 0;
	}

	private chunkKey(sessionId: string, assetId: string) {
		return `${sessionId}:${assetId}`;
	}

	private cloneSession(session: BrowserStudioVaultSession) {
		return JSON.parse(JSON.stringify(session)) as BrowserStudioVaultSession;
	}
}

const blobToText = async (blob: Blob) =>
	new TextDecoder().decode(await blob.arrayBuffer());

describe("BrowserStudioVault", () => {
	it("persists separate editable assets with checksummed chunks", async () => {
		const backend = new MemoryBrowserStudioVaultBackend();
		const vault = await BrowserStudioVault.create(
			{
				sessionId: "studio-session-1",
				browser: {
					userAgent:
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
					platform: "MacIntel",
				},
			},
			backend,
		);

		const screen = await vault.createAsset({
			assetId: "screen-asset",
			trackId: "screen-track",
			kind: "screen",
			label: "Screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
		});
		const camera = await vault.createAsset({
			assetId: "camera-asset",
			trackId: "camera-track",
			kind: "camera",
			label: "Camera",
			mimeType: "video/mp4",
			fileExtension: "mp4",
			width: 1280,
			height: 720,
			frameRate: 30,
		});

		await Promise.all([
			vault.appendChunk(screen.assetId, new Blob(["screen-1|"])),
			vault.appendChunk(screen.assetId, new Blob(["screen-2"])),
			vault.appendChunk(camera.assetId, new Blob(["camera"])),
		]);

		const session = vault.getSession();
		const [screenAsset, cameraAsset] = session.assets;

		expect(session.totalBytes).toBe(23);
		expect(session.chunkCount).toBe(3);
		expect(
			session.project.timeline.tracks.map((track) => track.assetId),
		).toEqual(["screen-asset", "camera-asset"]);
		expect(screenAsset?.chunkCount).toBe(2);
		expect(cameraAsset?.chunkCount).toBe(1);
		expect(screenAsset?.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
		expect(screenAsset?.chunks[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
		expect(backend.getChunkCount("studio-session-1", "screen-asset")).toBe(2);

		const screenBlob = await vault.recoverAssetBlob("screen-asset");
		const cameraBlob = await vault.recoverAssetBlob("camera-asset");

		expect(screenBlob?.type).toBe("video/mp4");
		expect(cameraBlob?.type).toBe("video/mp4");
		expect(await blobToText(screenBlob as Blob)).toBe("screen-1|screen-2");
		expect(await blobToText(cameraBlob as Blob)).toBe("camera");
	});

	it("finalizes a project manifest without flattening source assets", async () => {
		const backend = new MemoryBrowserStudioVaultBackend();
		const vault = await BrowserStudioVault.create(
			{ sessionId: "studio-session-finalize" },
			backend,
		);
		const screen = await vault.createAsset({
			assetId: "screen-asset",
			trackId: "screen-track",
			kind: "screen",
			label: "Screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
		});

		await vault.appendChunk(screen.assetId, new Blob(["screen"]));
		const session = await vault.finalize({
			durationMs: 5400,
			title: "Browser Studio recording",
		});

		expect(session.status).toBe("ready");
		expect(session.project.title).toBe("Browser Studio recording");
		expect(session.project.timeline.durationMs).toBe(5400);
		expect(session.project.timeline.tracks[0]?.durationMs).toBe(5400);
		expect(session.assets[0]?.chunkCount).toBe(1);
	});

	it("attaches cloud video state after local finalization", async () => {
		const backend = new MemoryBrowserStudioVaultBackend();
		const vault = await BrowserStudioVault.create(
			{ sessionId: "studio-session-video-state" },
			backend,
		);

		await vault.attachVideo("video-123");
		await vault.updateStatus("uploading");
		await vault.updateStatus("uploaded");

		const [session] = await backend.listSessions();

		expect(session?.videoId).toBe("video-123");
		expect(session?.status).toBe("uploaded");
	});

	it("recovers sessions newest first and deletes only explicit dismissals", async () => {
		const backend = new MemoryBrowserStudioVaultBackend();
		const older = await BrowserStudioVault.create(
			{ sessionId: "older-studio-session" },
			backend,
		);
		const olderAsset = await older.createAsset({
			assetId: "older-screen",
			kind: "screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
		});
		await older.appendChunk(olderAsset.assetId, new Blob(["older"]));
		const newer = await BrowserStudioVault.create(
			{ sessionId: "newer-studio-session" },
			backend,
		);
		const newerAsset = await newer.createAsset({
			assetId: "newer-screen",
			kind: "screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
		});
		await newer.appendChunk(newerAsset.assetId, new Blob(["newer"]));

		const recovered = await recoverBrowserStudioVaultSessions(backend);

		expect(recovered.map((session) => session.sessionId)).toEqual([
			"newer-studio-session",
			"older-studio-session",
		]);
		expect(backend.getSessionCount()).toBe(2);

		await deleteBrowserStudioVaultSession("older-studio-session", backend);

		expect(backend.getSessionCount()).toBe(1);
		expect(backend.getChunkCount("older-studio-session", "older-screen")).toBe(
			0,
		);
		expect(backend.getChunkCount("newer-studio-session", "newer-screen")).toBe(
			1,
		);
	});

	it("keeps pending chunks recoverable after a storage failure", async () => {
		const backend = new MemoryBrowserStudioVaultBackend({ failureAtIndex: 1 });
		const vault = await BrowserStudioVault.create(
			{ sessionId: "studio-session-failure" },
			backend,
		);
		const screen = await vault.createAsset({
			assetId: "screen-asset",
			kind: "screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
		});

		await vault.appendChunk(screen.assetId, new Blob(["first|"]));
		await expect(
			vault.appendChunk(screen.assetId, new Blob(["second"])),
		).rejects.toThrow("Failed to persist Browser Studio chunk 1");
		await expect(vault.flush()).rejects.toThrow(
			"Failed to persist Browser Studio chunk 1",
		);

		const recovered = await vault.recoverAssetBlob(screen.assetId);

		expect(await blobToText(recovered as Blob)).toBe("first|second");
	});

	it("fails fast when local persistence falls behind capture", async () => {
		const backend = new MemoryBrowserStudioVaultBackend();
		const vault = await BrowserStudioVault.create(
			{
				sessionId: "studio-session-backpressure",
				maxPendingChunkBytes: 3,
			},
			backend,
		);
		const screen = await vault.createAsset({
			assetId: "screen-asset",
			kind: "screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
		});

		await expect(
			vault.appendChunk(screen.assetId, new Blob(["1234"])),
		).rejects.toBeInstanceOf(BrowserStudioVaultBackpressureError);
		expect(
			backend.getChunkCount("studio-session-backpressure", "screen-asset"),
		).toBe(0);
	});
});
