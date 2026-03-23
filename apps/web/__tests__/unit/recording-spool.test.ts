import { describe, expect, it } from "vitest";
import {
	deleteRecoveredRecordingSpool,
	RecordingSpool,
	type RecordingSpoolBackend,
	RecordingSpoolBackpressureError,
	type RecordingSpoolSessionRecord,
	recoverOrphanedRecordingSpools,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool";

class MemoryRecordingSpoolBackend implements RecordingSpoolBackend {
	private readonly sessions = new Map<string, RecordingSpoolSessionRecord>();
	private readonly chunks = new Map<
		string,
		Array<{ index: number; blob: Blob }>
	>();
	private readonly failureAtIndex: number | null;
	private readonly readFailureSessionId: string | null;

	constructor(options?: {
		failureAtIndex?: number | null;
		readFailureSessionId?: string | null;
	}) {
		this.failureAtIndex = options?.failureAtIndex ?? null;
		this.readFailureSessionId = options?.readFailureSessionId ?? null;
	}

	async initialize() {}

	async createSession(session: RecordingSpoolSessionRecord) {
		this.sessions.set(session.sessionId, session);
	}

	async appendChunk(
		session: RecordingSpoolSessionRecord,
		index: number,
		chunk: Blob,
	) {
		if (this.failureAtIndex === index) {
			throw new Error(`Failed to persist chunk ${index}`);
		}

		this.sessions.set(session.sessionId, session);
		const existingChunks = this.chunks.get(session.sessionId) ?? [];
		existingChunks.push({ index, blob: chunk });
		this.chunks.set(session.sessionId, existingChunks);
	}

	async readChunks(sessionId: string) {
		if (this.readFailureSessionId === sessionId) {
			throw new Error(`Failed to read chunks for ${sessionId}`);
		}

		return [...(this.chunks.get(sessionId) ?? [])]
			.sort((left, right) => left.index - right.index)
			.map((chunk) => chunk.blob);
	}

	async listSessions() {
		return [...this.sessions.values()];
	}

	async deleteSession(sessionId: string) {
		this.sessions.delete(sessionId);
		this.chunks.delete(sessionId);
	}

	getSessionCount() {
		return this.sessions.size;
	}

	getChunkCount(sessionId: string) {
		return this.chunks.get(sessionId)?.length ?? 0;
	}
}

const blobToText = async (blob: Blob) =>
	new TextDecoder().decode(await blob.arrayBuffer());

class DelayedRecordingSpoolBackend implements RecordingSpoolBackend {
	private readonly sessions = new Map<string, RecordingSpoolSessionRecord>();
	private readonly chunks = new Map<
		string,
		Array<{ index: number; blob: Blob }>
	>();
	private resolveAppend: (() => void) | null = null;
	private pendingAppend: Promise<void> | null = null;

	async initialize() {}

	async createSession(session: RecordingSpoolSessionRecord) {
		this.sessions.set(session.sessionId, session);
	}

	async appendChunk(
		session: RecordingSpoolSessionRecord,
		index: number,
		chunk: Blob,
	) {
		this.sessions.set(session.sessionId, session);

		if (!this.pendingAppend) {
			this.pendingAppend = new Promise<void>((resolve) => {
				this.resolveAppend = resolve;
			});
		}

		await this.pendingAppend;

		const existingChunks = this.chunks.get(session.sessionId) ?? [];
		existingChunks.push({ index, blob: chunk });
		this.chunks.set(session.sessionId, existingChunks);
	}

	async readChunks(sessionId: string) {
		return [...(this.chunks.get(sessionId) ?? [])]
			.sort((left, right) => left.index - right.index)
			.map((entry) => entry.blob);
	}

	async listSessions() {
		return [...this.sessions.values()];
	}

	async deleteSession(sessionId: string) {
		this.sessions.delete(sessionId);
		this.chunks.delete(sessionId);
	}

	releaseAppend() {
		this.resolveAppend?.();
		this.resolveAppend = null;
		this.pendingAppend = null;
	}
}

describe("RecordingSpool", () => {
	it("persists chunks in order and rebuilds the recording blob", async () => {
		const backend = new MemoryRecordingSpoolBackend();
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm;codecs=vp9,opus",
				sessionId: "session-1",
			},
			backend,
		);

		await spool.appendChunk(new Blob(["first-"], { type: "video/webm" }));
		await spool.appendChunk(new Blob(["second"], { type: "video/webm" }));

		expect(spool.chunkCount).toBe(2);
		expect(spool.totalBytes).toBe(12);

		const blob = await spool.toBlob();

		expect(blob).not.toBeNull();
		expect(blob?.type).toBe("video/webm;codecs=vp9,opus");
		expect(await blobToText(blob as Blob)).toBe("first-second");
	});

	it("keeps queued chunk indexes unique when appends overlap", async () => {
		const backend = new MemoryRecordingSpoolBackend();
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-overlap",
			},
			backend,
		);

		await Promise.all([
			spool.appendChunk(new Blob(["first-"], { type: "video/webm" })),
			spool.appendChunk(new Blob(["second-"], { type: "video/webm" })),
			spool.appendChunk(new Blob(["third"], { type: "video/webm" })),
		]);

		const blob = await spool.toBlob();

		expect(await blobToText(blob as Blob)).toBe("first-second-third");
		expect(spool.chunkCount).toBe(3);
		expect(backend.getChunkCount("session-overlap")).toBe(3);
	});

	it("cleans up persisted state when disposed", async () => {
		const backend = new MemoryRecordingSpoolBackend();
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-2",
			},
			backend,
		);

		await spool.appendChunk(new Blob(["chunk"], { type: "video/webm" }));
		expect(backend.getSessionCount()).toBe(1);
		expect(backend.getChunkCount("session-2")).toBe(1);

		await spool.dispose();

		expect(backend.getSessionCount()).toBe(0);
		expect(backend.getChunkCount("session-2")).toBe(0);
	});

	it("fails fast when the pending spool backlog grows beyond its limit", async () => {
		const backend = new DelayedRecordingSpoolBackend();
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-backpressure",
				maxPendingChunkBytes: 6,
			},
			backend,
		);

		const firstWrite = spool.appendChunk(
			new Blob(["1234"], { type: "video/webm" }),
		);

		await expect(
			spool.appendChunk(new Blob(["5678"], { type: "video/webm" })),
		).rejects.toBeInstanceOf(RecordingSpoolBackpressureError);

		backend.releaseAppend();
		await Promise.allSettled([firstWrite]);

		const recoveredBlob = await spool.recoverBlob();

		expect(await blobToText(recoveredBlob as Blob)).toBe("12345678");
	});

	it("surfaces storage write failures", async () => {
		const backend = new MemoryRecordingSpoolBackend({ failureAtIndex: 1 });
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-3",
			},
			backend,
		);

		await spool.appendChunk(new Blob(["chunk-1"], { type: "video/webm" }));
		await expect(
			spool.appendChunk(new Blob(["chunk-2"], { type: "video/webm" })),
		).rejects.toThrow("Failed to persist chunk 1");
		await expect(spool.toBlob()).rejects.toThrow("Failed to persist chunk 1");
	});

	it("recovers the persisted data and failed in-memory chunk after a write failure", async () => {
		const backend = new MemoryRecordingSpoolBackend({ failureAtIndex: 1 });
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-4",
			},
			backend,
		);

		await spool.appendChunk(new Blob(["chunk-1"], { type: "video/webm" }));
		await expect(
			spool.appendChunk(new Blob(["chunk-2"], { type: "video/webm" })),
		).rejects.toThrow("Failed to persist chunk 1");

		const blob = await spool.recoverBlob();

		expect(await blobToText(blob as Blob)).toBe("chunk-1chunk-2");
	});

	it("keeps queued in-memory chunks available after a write failure", async () => {
		const backend = new MemoryRecordingSpoolBackend({ failureAtIndex: 1 });
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-5",
			},
			backend,
		);

		const firstWrite = spool.appendChunk(
			new Blob(["chunk-1|"], { type: "video/webm" }),
		);
		const secondWrite = spool.appendChunk(
			new Blob(["chunk-2|"], { type: "video/webm" }),
		);
		const thirdWrite = spool.appendChunk(
			new Blob(["chunk-3"], { type: "video/webm" }),
		);

		await firstWrite;
		await expect(secondWrite).rejects.toThrow("Failed to persist chunk 1");
		await expect(thirdWrite).rejects.toThrow("Failed to persist chunk 1");

		const blob = await spool.recoverBlob();

		expect(await blobToText(blob as Blob)).toBe("chunk-1|chunk-2|chunk-3");
	});

	it("cleans up persisted state after a write failure", async () => {
		const backend = new MemoryRecordingSpoolBackend({ failureAtIndex: 1 });
		const spool = await RecordingSpool.create(
			{
				mimeType: "video/webm",
				sessionId: "session-cleanup",
			},
			backend,
		);

		await spool.appendChunk(new Blob(["chunk-1"], { type: "video/webm" }));
		await expect(
			spool.appendChunk(new Blob(["chunk-2"], { type: "video/webm" })),
		).rejects.toThrow("Failed to persist chunk 1");

		await spool.dispose();

		expect(backend.getSessionCount()).toBe(0);
		expect(backend.getChunkCount("session-cleanup")).toBe(0);
	});

	it("recovers orphaned spools in newest-first order without deleting them", async () => {
		const backend = new MemoryRecordingSpoolBackend();
		await backend.initialize();
		await backend.createSession({
			sessionId: "older",
			mimeType: "video/webm",
			totalBytes: 5,
			chunkCount: 1,
			createdAt: 100,
			updatedAt: 200,
		});
		await backend.appendChunk(
			{
				sessionId: "older",
				mimeType: "video/webm",
				totalBytes: 5,
				chunkCount: 1,
				createdAt: 100,
				updatedAt: 200,
			},
			0,
			new Blob(["older"], { type: "video/webm" }),
		);
		await backend.createSession({
			sessionId: "newer",
			mimeType: "video/webm",
			totalBytes: 5,
			chunkCount: 1,
			createdAt: 300,
			updatedAt: 400,
		});
		await backend.appendChunk(
			{
				sessionId: "newer",
				mimeType: "video/webm",
				totalBytes: 5,
				chunkCount: 1,
				createdAt: 300,
				updatedAt: 400,
			},
			0,
			new Blob(["newer"], { type: "video/webm" }),
		);

		const recovered = await recoverOrphanedRecordingSpools(backend);
		const [newer, older] = recovered;

		expect(recovered.map((item) => item.sessionId)).toEqual(["newer", "older"]);
		if (!newer || !older) {
			throw new Error("Expected recovered recordings");
		}
		expect(await blobToText(newer.blob)).toBe("newer");
		expect(await blobToText(older.blob)).toBe("older");
		expect(backend.getSessionCount()).toBe(2);
		expect(backend.getChunkCount("newer")).toBe(1);
		expect(backend.getChunkCount("older")).toBe(1);
	});

	it("deletes recovered spools only when explicitly dismissed", async () => {
		const backend = new MemoryRecordingSpoolBackend();
		await backend.initialize();
		await backend.createSession({
			sessionId: "dismiss-me",
			mimeType: "video/webm",
			totalBytes: 5,
			chunkCount: 1,
			createdAt: 100,
			updatedAt: 200,
		});
		await backend.appendChunk(
			{
				sessionId: "dismiss-me",
				mimeType: "video/webm",
				totalBytes: 5,
				chunkCount: 1,
				createdAt: 100,
				updatedAt: 200,
			},
			0,
			new Blob(["stale"], { type: "video/webm" }),
		);

		await deleteRecoveredRecordingSpool("dismiss-me", backend);

		expect(backend.getSessionCount()).toBe(0);
		expect(backend.getChunkCount("dismiss-me")).toBe(0);
	});

	it("preserves sessions that fail during recovery so they can be retried later", async () => {
		const backend = new MemoryRecordingSpoolBackend({
			readFailureSessionId: "stuck",
		});
		await backend.initialize();
		await backend.createSession({
			sessionId: "stuck",
			mimeType: "video/webm",
			totalBytes: 5,
			chunkCount: 1,
			createdAt: 100,
			updatedAt: 200,
		});
		await backend.appendChunk(
			{
				sessionId: "stuck",
				mimeType: "video/webm",
				totalBytes: 5,
				chunkCount: 1,
				createdAt: 100,
				updatedAt: 200,
			},
			0,
			new Blob(["stuck"], { type: "video/webm" }),
		);

		const recovered = await recoverOrphanedRecordingSpools(backend);

		expect(recovered).toEqual([]);
		expect(backend.getSessionCount()).toBe(1);
		expect(backend.getChunkCount("stuck")).toBe(1);
	});
});
