export type RecordingSpoolSessionRecord = {
	sessionId: string;
	mimeType: string;
	totalBytes: number;
	chunkCount: number;
	createdAt: number;
	updatedAt: number;
};

type RecordingSpoolChunk = {
	sessionId: string;
	index: number;
	blob: Blob;
};

export interface RecordingSpoolBackend {
	initialize(): Promise<void>;
	createSession(session: RecordingSpoolSessionRecord): Promise<void>;
	appendChunk(
		session: RecordingSpoolSessionRecord,
		index: number,
		chunk: Blob,
	): Promise<void>;
	readChunks(sessionId: string): Promise<Blob[]>;
	listSessions(): Promise<RecordingSpoolSessionRecord[]>;
	deleteSession(sessionId: string): Promise<void>;
	/** Keyed lookup; backends without it fall back to listSessions(). */
	getSession?(sessionId: string): Promise<RecordingSpoolSessionRecord | null>;
}

export type RecoveredRecordingSpool = RecordingSpoolSessionRecord & {
	blob: Blob;
};

const DATABASE_NAME = "cap-recording-spool";
const DATABASE_VERSION = 1;
const SESSIONS_STORE = "sessions";
const CHUNKS_STORE = "chunks";
const DEFAULT_MAX_PENDING_CHUNK_BYTES = 32 * 1024 * 1024;

// Liveness contract between live recorders and recovery sweeps: a spool whose
// session was updated within this window must be treated as live and never
// offered as "recovered" (dismissing a recovered spool deletes the live
// session's crash backup out from under it). Chunk writes alone are not a
// reliable liveness signal — a paused MediaRecorder produces no chunks — so
// recorders also call RecordingSpool.touch() on the heartbeat interval below.
// The window is sized at 3x the worst-case heartbeat cadence: background tabs
// under Chrome's intensive timer throttling fire intervals as rarely as once
// per minute.
export const RECORDING_SPOOL_LIVE_MIN_IDLE_MS = 3 * 60 * 1000;
export const RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const normalizeError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

const requestToPromise = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(normalizeError(request.error));
	});

const transactionToPromise = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(normalizeError(transaction.error));
		transaction.onerror = () => reject(normalizeError(transaction.error));
	});

const createSessionId = () => {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}

	return `recording-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export class RecordingSpoolBackpressureError extends Error {
	constructor() {
		super("Recording spool could not keep up with capture");
		this.name = "RecordingSpoolBackpressureError";
	}
}

class IndexedDbRecordingSpoolBackend implements RecordingSpoolBackend {
	private databasePromise: Promise<IDBDatabase> | null = null;

	async initialize() {
		await this.openDatabase();
	}

	async createSession(session: RecordingSpoolSessionRecord) {
		const database = await this.openDatabase();
		const transaction = database.transaction(SESSIONS_STORE, "readwrite");
		transaction.objectStore(SESSIONS_STORE).put(session);
		await transactionToPromise(transaction);
	}

	async appendChunk(
		session: RecordingSpoolSessionRecord,
		index: number,
		chunk: Blob,
	) {
		const database = await this.openDatabase();
		const transaction = database.transaction(
			[SESSIONS_STORE, CHUNKS_STORE],
			"readwrite",
		);
		transaction.objectStore(SESSIONS_STORE).put(session);
		transaction.objectStore(CHUNKS_STORE).put({
			sessionId: session.sessionId,
			index,
			blob: chunk,
		} satisfies RecordingSpoolChunk);
		await transactionToPromise(transaction);
	}

	async readChunks(sessionId: string) {
		const database = await this.openDatabase();
		const transaction = database.transaction(CHUNKS_STORE, "readonly");
		const index = transaction.objectStore(CHUNKS_STORE).index("by-session");
		const records = await requestToPromise(
			index.getAll(IDBKeyRange.only(sessionId)),
		);
		await transactionToPromise(transaction);
		return (records as RecordingSpoolChunk[]).map((record) => record.blob);
	}

	async listSessions() {
		const database = await this.openDatabase();
		const transaction = database.transaction(SESSIONS_STORE, "readonly");
		const records = await requestToPromise(
			transaction.objectStore(SESSIONS_STORE).getAll(),
		);
		await transactionToPromise(transaction);
		return records as RecordingSpoolSessionRecord[];
	}

	async getSession(sessionId: string) {
		const database = await this.openDatabase();
		const transaction = database.transaction(SESSIONS_STORE, "readonly");
		const record = await requestToPromise(
			transaction.objectStore(SESSIONS_STORE).get(sessionId),
		);
		await transactionToPromise(transaction);
		return (record as RecordingSpoolSessionRecord | undefined) ?? null;
	}

	async deleteSession(sessionId: string) {
		const database = await this.openDatabase();
		const existingChunks = await this.readChunkKeys(sessionId);
		const transaction = database.transaction(
			[SESSIONS_STORE, CHUNKS_STORE],
			"readwrite",
		);
		transaction.objectStore(SESSIONS_STORE).delete(sessionId);
		const chunksStore = transaction.objectStore(CHUNKS_STORE);
		existingChunks.forEach((key) => {
			chunksStore.delete(key);
		});
		await transactionToPromise(transaction);
	}

	private openDatabase() {
		if (!this.databasePromise) {
			this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
				if (typeof indexedDB === "undefined") {
					reject(new Error("IndexedDB is not available"));
					return;
				}

				const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
				request.onupgradeneeded = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
						database.createObjectStore(SESSIONS_STORE, {
							keyPath: "sessionId",
						});
					}
					if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
						const chunksStore = database.createObjectStore(CHUNKS_STORE, {
							keyPath: ["sessionId", "index"],
						});
						chunksStore.createIndex("by-session", "sessionId", {
							unique: false,
						});
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(normalizeError(request.error));
			});
		}

		return this.databasePromise;
	}

	private async readChunkKeys(sessionId: string) {
		const database = await this.openDatabase();
		const transaction = database.transaction(CHUNKS_STORE, "readonly");
		const index = transaction.objectStore(CHUNKS_STORE).index("by-session");
		const keys = await requestToPromise(
			index.getAllKeys(IDBKeyRange.only(sessionId)),
		);
		await transactionToPromise(transaction);
		return keys;
	}
}

export class RecordingSpool {
	private session: RecordingSpoolSessionRecord;
	private nextChunkIndex = 0;
	private pendingWrite = Promise.resolve();
	private pendingChunks: Blob[] = [];
	private pendingChunkBytes = 0;
	private writeError: Error | null = null;
	private disposed = false;

	private constructor(
		private readonly backend: RecordingSpoolBackend,
		session: RecordingSpoolSessionRecord,
		private readonly maxPendingChunkBytes: number,
	) {
		this.session = session;
	}

	static async create(
		options: {
			mimeType: string;
			sessionId?: string;
			maxPendingChunkBytes?: number;
		},
		backend: RecordingSpoolBackend = new IndexedDbRecordingSpoolBackend(),
	) {
		const now = Date.now();
		const session = {
			sessionId: options.sessionId ?? createSessionId(),
			mimeType: options.mimeType,
			totalBytes: 0,
			chunkCount: 0,
			createdAt: now,
			updatedAt: now,
		} satisfies RecordingSpoolSessionRecord;

		await backend.initialize();
		await backend.createSession(session);

		return new RecordingSpool(
			backend,
			session,
			options.maxPendingChunkBytes ?? DEFAULT_MAX_PENDING_CHUNK_BYTES,
		);
	}

	get sessionId() {
		return this.session.sessionId;
	}

	get totalBytes() {
		return this.session.totalBytes;
	}

	get chunkCount() {
		return this.session.chunkCount;
	}

	appendChunk(chunk: Blob) {
		if (this.disposed) {
			return Promise.reject(new Error("Recording spool has been disposed"));
		}

		if (this.writeError) {
			return Promise.reject(this.writeError);
		}

		this.pendingChunks.push(chunk);
		this.pendingChunkBytes += chunk.size;
		if (this.pendingChunkBytes > this.maxPendingChunkBytes) {
			this.writeError = new RecordingSpoolBackpressureError();
			return Promise.reject(this.writeError);
		}

		return this.enqueue(async () => {
			const index = this.nextChunkIndex;
			const updatedSession = {
				...this.session,
				totalBytes: this.session.totalBytes + chunk.size,
				chunkCount: this.session.chunkCount + 1,
				updatedAt: Date.now(),
			} satisfies RecordingSpoolSessionRecord;

			await this.backend.appendChunk(updatedSession, index, chunk);
			const persistedChunk = this.pendingChunks.shift();
			if (persistedChunk) {
				this.pendingChunkBytes = Math.max(
					0,
					this.pendingChunkBytes - persistedChunk.size,
				);
			}
			this.nextChunkIndex = index + 1;
			this.session = updatedSession;
		});
	}

	// Heartbeat for the liveness contract above: refreshes the session's
	// updatedAt without writing a chunk so paused recordings stay recognisably
	// live to recovery sweeps in other tabs. Failures are swallowed and do not
	// poison the write queue — a missed heartbeat must never degrade an
	// otherwise healthy spool.
	touch(): Promise<void> {
		if (this.disposed || this.writeError) {
			return Promise.resolve();
		}

		const operation = this.pendingWrite.then(async () => {
			if (this.disposed || this.writeError) return;
			const updatedSession = {
				...this.session,
				updatedAt: Date.now(),
			} satisfies RecordingSpoolSessionRecord;
			await this.backend.createSession(updatedSession);
			this.session = updatedSession;
		});
		this.pendingWrite = operation.then(
			() => undefined,
			() => undefined,
		);

		return operation.catch(() => undefined);
	}

	async flush() {
		await this.pendingWrite;
		if (this.writeError) {
			throw this.writeError;
		}
	}

	async toBlob() {
		await this.flush();
		return this.readPersistedBlob();
	}

	async recoverBlob() {
		await this.pendingWrite;
		const persistedBlob = await this.readPersistedBlob();
		if (this.pendingChunks.length === 0) {
			return persistedBlob;
		}

		return new Blob(
			persistedBlob
				? [persistedBlob, ...this.pendingChunks]
				: [...this.pendingChunks],
			{ type: this.session.mimeType },
		);
	}

	private async readPersistedBlob() {
		const chunks = await this.backend.readChunks(this.session.sessionId);
		if (chunks.length === 0) {
			return null;
		}

		return new Blob(chunks, { type: this.session.mimeType });
	}

	async dispose() {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.pendingChunks = [];
		this.pendingChunkBytes = 0;
		try {
			await this.pendingWrite;
		} catch {}
		await this.backend.deleteSession(this.session.sessionId);
	}

	private enqueue(task: () => Promise<void>) {
		const operation = this.pendingWrite.then(async () => {
			if (this.writeError) {
				throw this.writeError;
			}

			await task();
		});
		this.pendingWrite = operation.then(
			() => undefined,
			() => undefined,
		);

		return operation.catch((error) => {
			this.writeError = normalizeError(error);
			throw this.writeError;
		});
	}
}

export const canUseRecordingSpool = () =>
	typeof window !== "undefined" && typeof indexedDB !== "undefined";

export const recoverOrphanedRecordingSpools = async (
	backend: RecordingSpoolBackend = new IndexedDbRecordingSpoolBackend(),
	options: { minIdleMs?: number } = {},
) => {
	await backend.initialize();
	const sessions = await backend.listSessions();
	const recovered: RecoveredRecordingSpool[] = [];
	const minIdleMs = options.minIdleMs ?? 0;
	const now = Date.now();

	for (const session of sessions) {
		// A session updated this recently may belong to a recording that is
		// live in another tab (or just starting in this one). Recovering it
		// would offer the user a "recovered" copy whose dismissal deletes the
		// live session's crash backup out from under it.
		if (minIdleMs > 0 && now - session.updatedAt < minIdleMs) {
			continue;
		}

		try {
			const chunks = await backend.readChunks(session.sessionId);
			if (chunks.length === 0) {
				await backend.deleteSession(session.sessionId);
				continue;
			}

			recovered.push({
				...session,
				blob: new Blob(chunks, { type: session.mimeType }),
			});
		} catch (error) {
			console.error(
				"Failed to recover orphaned recording spool",
				session.sessionId,
				error,
			);
		}
	}

	return recovered.sort((left, right) => right.updatedAt - left.updatedAt);
};

// Session metadata only — no chunk reads, no Blob construction. Startup
// sweeps that just reconcile bookkeeping use this instead of
// recoverOrphanedRecordingSpools, which materialises every stranded
// recording's bytes.
export const listRecordingSpoolSessions = async (
	backend: RecordingSpoolBackend = new IndexedDbRecordingSpoolBackend(),
): Promise<RecordingSpoolSessionRecord[]> => {
	await backend.initialize();
	const sessions = await backend.listSessions();
	return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
};

// Recover a single session without reading every other session's chunks;
// retry and download paths know exactly which spool they need, so a full
// recoverOrphanedRecordingSpools sweep would be wasted I/O.
export const recoverRecordingSpoolSession = async (
	sessionId: string,
	backend: RecordingSpoolBackend = new IndexedDbRecordingSpoolBackend(),
): Promise<RecoveredRecordingSpool | null> => {
	await backend.initialize();
	const session = backend.getSession
		? await backend.getSession(sessionId)
		: ((await backend.listSessions()).find(
				(entry) => entry.sessionId === sessionId,
			) ?? null);
	if (!session) {
		return null;
	}

	const chunks = await backend.readChunks(session.sessionId);
	if (chunks.length === 0) {
		return null;
	}

	return {
		...session,
		blob: new Blob(chunks, { type: session.mimeType }),
	};
};

export const deleteRecoveredRecordingSpool = async (
	sessionId: string,
	backend: RecordingSpoolBackend = new IndexedDbRecordingSpoolBackend(),
) => {
	await backend.initialize();
	await backend.deleteSession(sessionId);
};
