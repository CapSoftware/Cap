"use client";

export type BrowserStudioAssetKind =
	| "screen"
	| "camera"
	| "microphone"
	| "system-audio"
	| "mixed";

export type BrowserStudioVaultStatus =
	| "recording"
	| "ready"
	| "uploading"
	| "uploaded"
	| "failed";

export type BrowserStudioBrowserInfo = {
	userAgent: string;
	platform: string | null;
};

export type BrowserStudioVaultChunk = {
	index: number;
	size: number;
	checksum: string;
	createdAt: number;
};

export type BrowserStudioVaultAsset = {
	assetId: string;
	trackId: string;
	kind: BrowserStudioAssetKind;
	label: string;
	mimeType: string;
	fileExtension: string;
	width: number | null;
	height: number | null;
	frameRate: number | null;
	sampleRate: number | null;
	channelCount: number | null;
	totalBytes: number;
	chunkCount: number;
	chunks: BrowserStudioVaultChunk[];
};

export type BrowserStudioVaultTrack = {
	trackId: string;
	assetId: string;
	kind: BrowserStudioAssetKind;
	label: string;
	startMs: number;
	durationMs: number | null;
	muted: boolean;
};

export type BrowserStudioVaultProject = {
	schemaVersion: 1;
	source: "browser-recorder";
	title: string | null;
	timeline: {
		durationMs: number | null;
		tracks: BrowserStudioVaultTrack[];
	};
	exportSettings: {
		format: "mp4";
		quality: "source";
	};
};

export type BrowserStudioVaultSession = {
	schemaVersion: 1;
	sessionId: string;
	videoId: string | null;
	status: BrowserStudioVaultStatus;
	createdAt: number;
	updatedAt: number;
	browser: BrowserStudioBrowserInfo;
	project: BrowserStudioVaultProject;
	assets: BrowserStudioVaultAsset[];
	totalBytes: number;
	chunkCount: number;
};

export type BrowserStudioVaultAssetInput = {
	assetId?: string;
	trackId?: string;
	kind: BrowserStudioAssetKind;
	label?: string;
	mimeType: string;
	fileExtension: string;
	width?: number | null;
	height?: number | null;
	frameRate?: number | null;
	sampleRate?: number | null;
	channelCount?: number | null;
};

export interface BrowserStudioVaultBackend {
	initialize(): Promise<void>;
	createSession(session: BrowserStudioVaultSession): Promise<void>;
	updateSession(session: BrowserStudioVaultSession): Promise<void>;
	appendChunk(
		session: BrowserStudioVaultSession,
		assetId: string,
		index: number,
		chunk: Blob,
		metadata: BrowserStudioVaultChunk,
	): Promise<void>;
	readChunks(sessionId: string, assetId: string): Promise<Blob[]>;
	listSessions(): Promise<BrowserStudioVaultSession[]>;
	deleteSession(sessionId: string): Promise<void>;
}

type BrowserStudioVaultOptions = {
	sessionId?: string;
	videoId?: string | null;
	title?: string | null;
	browser?: Partial<BrowserStudioBrowserInfo>;
	maxPendingChunkBytes?: number;
};

type PendingChunk = {
	assetId: string;
	blob: Blob;
};

type BrowserStudioStorageManager = StorageManager & {
	getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

type IterableFileSystemDirectoryHandle = FileSystemDirectoryHandle & {
	entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const OPFS_ROOT_DIRECTORY = "cap-browser-studio-vault";
const MANIFEST_FILE = "manifest.json";
const INDEXED_DB_NAME = "cap-browser-studio-vault";
const INDEXED_DB_VERSION = 1;
const SESSIONS_STORE = "sessions";
const CHUNKS_STORE = "chunks";
const DEFAULT_MAX_PENDING_CHUNK_BYTES = 64 * 1024 * 1024;
let lastTimestamp = 0;

const normalizeError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

const cloneSession = (session: BrowserStudioVaultSession) =>
	JSON.parse(JSON.stringify(session)) as BrowserStudioVaultSession;

const now = () => {
	const current = Date.now();
	const next = current <= lastTimestamp ? lastTimestamp + 1 : current;
	lastTimestamp = next;
	return next;
};

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

const createId = (prefix: string) => {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	return `${prefix}-${now()}-${Math.random().toString(36).slice(2)}`;
};

const describeBrowser = (
	browser: Partial<BrowserStudioBrowserInfo> | undefined,
) => ({
	userAgent:
		browser?.userAgent ??
		(typeof navigator !== "undefined" ? navigator.userAgent : "unknown"),
	platform:
		browser?.platform ??
		(typeof navigator !== "undefined" ? navigator.platform : null),
});

const createInitialProject = (
	title: string | null,
): BrowserStudioVaultProject => ({
	schemaVersion: 1,
	source: "browser-recorder",
	title,
	timeline: {
		durationMs: null,
		tracks: [],
	},
	exportSettings: {
		format: "mp4",
		quality: "source",
	},
});

const createInitialSession = (
	options: BrowserStudioVaultOptions,
): BrowserStudioVaultSession => {
	const createdAt = now();
	return {
		schemaVersion: 1,
		sessionId: options.sessionId ?? createId("browser-studio"),
		videoId: options.videoId ?? null,
		status: "recording",
		createdAt,
		updatedAt: createdAt,
		browser: describeBrowser(options.browser),
		project: createInitialProject(options.title ?? null),
		assets: [],
		totalBytes: 0,
		chunkCount: 0,
	};
};

const checksumBlob = async (blob: Blob) => {
	const buffer = await blob.arrayBuffer();
	if (
		typeof crypto !== "undefined" &&
		crypto.subtle &&
		typeof crypto.subtle.digest === "function"
	) {
		const digest = await crypto.subtle.digest("SHA-256", buffer);
		return [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	let hash = 2166136261;
	for (const byte of new Uint8Array(buffer)) {
		hash ^= byte;
		hash = Math.imul(hash, 16777619);
	}

	return hash.toString(16).padStart(8, "0");
};

const getOpfsRootDirectory = async () => {
	const storage =
		typeof navigator !== "undefined"
			? (navigator.storage as BrowserStudioStorageManager | undefined)
			: undefined;

	if (typeof storage?.getDirectory !== "function") {
		throw new Error("OPFS is not available");
	}

	const root = await storage.getDirectory();
	return root.getDirectoryHandle(OPFS_ROOT_DIRECTORY, { create: true });
};

const readJsonFile = async <T>(directory: FileSystemDirectoryHandle) => {
	const handle = await directory.getFileHandle(MANIFEST_FILE);
	const file = await handle.getFile();
	return JSON.parse(await file.text()) as T;
};

const writeJsonFile = async <T>(
	directory: FileSystemDirectoryHandle,
	value: T,
) => {
	const handle = await directory.getFileHandle(MANIFEST_FILE, { create: true });
	const writable = await handle.createWritable();
	await writable.write(JSON.stringify(value));
	await writable.close();
};

type IndexedDbBrowserStudioChunk = {
	sessionId: string;
	assetId: string;
	index: number;
	blob: Blob;
};

export class BrowserStudioVaultBackpressureError extends Error {
	constructor() {
		super("Browser Studio vault could not keep up with capture");
		this.name = "BrowserStudioVaultBackpressureError";
	}
}

export class OpfsBrowserStudioVaultBackend
	implements BrowserStudioVaultBackend
{
	private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

	async initialize() {
		await this.openRoot();
	}

	async createSession(session: BrowserStudioVaultSession) {
		const directory = await this.openSessionDirectory(session.sessionId, true);
		await writeJsonFile(directory, cloneSession(session));
	}

	async updateSession(session: BrowserStudioVaultSession) {
		const directory = await this.openSessionDirectory(session.sessionId, true);
		await writeJsonFile(directory, cloneSession(session));
	}

	async appendChunk(
		session: BrowserStudioVaultSession,
		assetId: string,
		index: number,
		chunk: Blob,
	) {
		const sessionDirectory = await this.openSessionDirectory(
			session.sessionId,
			true,
		);
		const assetsDirectory = await sessionDirectory.getDirectoryHandle(
			"assets",
			{ create: true },
		);
		const assetDirectory = await assetsDirectory.getDirectoryHandle(assetId, {
			create: true,
		});
		const handle = await assetDirectory.getFileHandle(`${index}.part`, {
			create: true,
		});
		const writable = await handle.createWritable();
		await writable.write(chunk);
		await writable.close();
		await writeJsonFile(sessionDirectory, cloneSession(session));
	}

	async readChunks(sessionId: string, assetId: string) {
		const sessionDirectory = await this.openSessionDirectory(sessionId, false);
		const session =
			await readJsonFile<BrowserStudioVaultSession>(sessionDirectory);
		const asset = session.assets.find((asset) => asset.assetId === assetId);
		if (!asset) return [];

		const assetsDirectory = await sessionDirectory.getDirectoryHandle("assets");
		const assetDirectory = await assetsDirectory.getDirectoryHandle(assetId);
		const chunks: Blob[] = [];

		for (const chunk of [...asset.chunks].sort(
			(left, right) => left.index - right.index,
		)) {
			const handle = await assetDirectory.getFileHandle(`${chunk.index}.part`);
			const file = await handle.getFile();
			chunks.push(file);
		}

		return chunks;
	}

	async listSessions() {
		const root = (await this.openRoot()) as IterableFileSystemDirectoryHandle;
		const sessions: BrowserStudioVaultSession[] = [];

		for await (const [name, handle] of root.entries()) {
			if (handle.kind !== "directory") continue;
			const session = await this.readSessionIfAvailable(name);
			if (session) sessions.push(session);
		}

		return sessions;
	}

	async deleteSession(sessionId: string) {
		const root = await this.openRoot();
		try {
			await root.removeEntry(sessionId, { recursive: true });
		} catch (error) {
			const normalized = normalizeError(error);
			if (normalized.name !== "NotFoundError") throw normalized;
		}
	}

	private openRoot() {
		if (!this.rootPromise) {
			this.rootPromise = getOpfsRootDirectory();
		}

		return this.rootPromise;
	}

	private async openSessionDirectory(sessionId: string, create: boolean) {
		const root = await this.openRoot();
		return root.getDirectoryHandle(sessionId, { create });
	}

	private async readSessionIfAvailable(sessionId: string) {
		try {
			const sessionDirectory = await this.openSessionDirectory(
				sessionId,
				false,
			);
			return await readJsonFile<BrowserStudioVaultSession>(sessionDirectory);
		} catch {
			return null;
		}
	}
}

export class IndexedDbBrowserStudioVaultBackend
	implements BrowserStudioVaultBackend
{
	private databasePromise: Promise<IDBDatabase> | null = null;

	async initialize() {
		await this.openDatabase();
	}

	async createSession(session: BrowserStudioVaultSession) {
		await this.putSession(session);
	}

	async updateSession(session: BrowserStudioVaultSession) {
		await this.putSession(session);
	}

	async appendChunk(
		session: BrowserStudioVaultSession,
		assetId: string,
		index: number,
		chunk: Blob,
	) {
		const database = await this.openDatabase();
		const transaction = database.transaction(
			[SESSIONS_STORE, CHUNKS_STORE],
			"readwrite",
		);
		transaction.objectStore(SESSIONS_STORE).put(cloneSession(session));
		transaction.objectStore(CHUNKS_STORE).put({
			sessionId: session.sessionId,
			assetId,
			index,
			blob: chunk,
		} satisfies IndexedDbBrowserStudioChunk);
		await transactionToPromise(transaction);
	}

	async readChunks(sessionId: string, assetId: string) {
		const database = await this.openDatabase();
		const transaction = database.transaction(CHUNKS_STORE, "readonly");
		const index = transaction
			.objectStore(CHUNKS_STORE)
			.index("by-session-asset");
		const records = await requestToPromise(
			index.getAll(IDBKeyRange.only([sessionId, assetId])),
		);
		await transactionToPromise(transaction);
		return (records as IndexedDbBrowserStudioChunk[])
			.sort((left, right) => left.index - right.index)
			.map((record) => record.blob);
	}

	async listSessions() {
		const database = await this.openDatabase();
		const transaction = database.transaction(SESSIONS_STORE, "readonly");
		const records = await requestToPromise(
			transaction.objectStore(SESSIONS_STORE).getAll(),
		);
		await transactionToPromise(transaction);
		return (records as BrowserStudioVaultSession[]).map(cloneSession);
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

	private async putSession(session: BrowserStudioVaultSession) {
		const database = await this.openDatabase();
		const transaction = database.transaction(SESSIONS_STORE, "readwrite");
		transaction.objectStore(SESSIONS_STORE).put(cloneSession(session));
		await transactionToPromise(transaction);
	}

	private openDatabase() {
		if (!this.databasePromise) {
			this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
				if (typeof indexedDB === "undefined") {
					reject(new Error("IndexedDB is not available"));
					return;
				}

				const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
				request.onupgradeneeded = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
						database.createObjectStore(SESSIONS_STORE, {
							keyPath: "sessionId",
						});
					}
					if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
						const chunksStore = database.createObjectStore(CHUNKS_STORE, {
							keyPath: ["sessionId", "assetId", "index"],
						});
						chunksStore.createIndex("by-session", "sessionId", {
							unique: false,
						});
						chunksStore.createIndex(
							"by-session-asset",
							["sessionId", "assetId"],
							{ unique: false },
						);
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

export class BrowserStudioVault {
	private session: BrowserStudioVaultSession;
	private pendingWrite = Promise.resolve();
	private pendingChunks = new Map<number, PendingChunk>();
	private pendingChunkBytes = 0;
	private writeError: Error | null = null;
	private disposed = false;
	private pendingSequence = 0;

	private constructor(
		private readonly backend: BrowserStudioVaultBackend,
		session: BrowserStudioVaultSession,
		private readonly maxPendingChunkBytes: number,
	) {
		this.session = session;
	}

	static async create(
		options: BrowserStudioVaultOptions = {},
		backend: BrowserStudioVaultBackend = createBrowserStudioVaultBackend(),
	) {
		const session = createInitialSession(options);
		await backend.initialize();
		await backend.createSession(session);

		return new BrowserStudioVault(
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

	getSession() {
		return cloneSession(this.session);
	}

	async createAsset(input: BrowserStudioVaultAssetInput) {
		return this.enqueue(async () => {
			const assetId = input.assetId ?? createId(`asset-${input.kind}`);
			const trackId = input.trackId ?? createId(`track-${input.kind}`);
			if (this.session.assets.some((asset) => asset.assetId === assetId)) {
				throw new Error(`Browser Studio asset already exists: ${assetId}`);
			}

			const asset = {
				assetId,
				trackId,
				kind: input.kind,
				label: input.label ?? input.kind,
				mimeType: input.mimeType,
				fileExtension: input.fileExtension,
				width: input.width ?? null,
				height: input.height ?? null,
				frameRate: input.frameRate ?? null,
				sampleRate: input.sampleRate ?? null,
				channelCount: input.channelCount ?? null,
				totalBytes: 0,
				chunkCount: 0,
				chunks: [],
			} satisfies BrowserStudioVaultAsset;
			const track = {
				trackId,
				assetId,
				kind: input.kind,
				label: asset.label,
				startMs: 0,
				durationMs: null,
				muted: false,
			} satisfies BrowserStudioVaultTrack;
			const updatedSession = {
				...this.session,
				updatedAt: now(),
				assets: [...this.session.assets, asset],
				project: {
					...this.session.project,
					timeline: {
						...this.session.project.timeline,
						tracks: [...this.session.project.timeline.tracks, track],
					},
				},
			} satisfies BrowserStudioVaultSession;

			await this.backend.updateSession(updatedSession);
			this.session = updatedSession;
			return asset;
		});
	}

	appendChunk(assetId: string, chunk: Blob) {
		if (this.disposed) {
			return Promise.reject(
				new Error("Browser Studio vault has been disposed"),
			);
		}

		if (this.writeError) {
			return Promise.reject(this.writeError);
		}

		if (!this.session.assets.some((asset) => asset.assetId === assetId)) {
			return Promise.reject(
				new Error(`Browser Studio asset not found: ${assetId}`),
			);
		}

		if (this.pendingChunkBytes + chunk.size > this.maxPendingChunkBytes) {
			return Promise.reject(new BrowserStudioVaultBackpressureError());
		}

		const pendingId = this.pendingSequence;
		this.pendingSequence += 1;
		this.pendingChunks.set(pendingId, { assetId, blob: chunk });
		this.pendingChunkBytes += chunk.size;

		return this.enqueue(async () => {
			const asset = this.session.assets.find(
				(candidate) => candidate.assetId === assetId,
			);
			if (!asset) throw new Error(`Browser Studio asset not found: ${assetId}`);

			const metadata = {
				index: asset.chunkCount,
				size: chunk.size,
				checksum: await checksumBlob(chunk),
				createdAt: now(),
			} satisfies BrowserStudioVaultChunk;
			const updatedAsset = {
				...asset,
				totalBytes: asset.totalBytes + chunk.size,
				chunkCount: asset.chunkCount + 1,
				chunks: [...asset.chunks, metadata],
			} satisfies BrowserStudioVaultAsset;
			const updatedSession = {
				...this.session,
				updatedAt: now(),
				assets: this.session.assets.map((candidate) =>
					candidate.assetId === assetId ? updatedAsset : candidate,
				),
				totalBytes: this.session.totalBytes + chunk.size,
				chunkCount: this.session.chunkCount + 1,
			} satisfies BrowserStudioVaultSession;

			await this.backend.appendChunk(
				updatedSession,
				assetId,
				metadata.index,
				chunk,
				metadata,
			);
			this.session = updatedSession;
			this.pendingChunks.delete(pendingId);
			this.pendingChunkBytes = Math.max(0, this.pendingChunkBytes - chunk.size);
		});
	}

	async finalize(options: { durationMs?: number; title?: string | null } = {}) {
		await this.flush();
		const durationMs =
			options.durationMs ?? this.session.project.timeline.durationMs;
		const updatedSession = {
			...this.session,
			status: "ready",
			updatedAt: now(),
			project: {
				...this.session.project,
				title: options.title ?? this.session.project.title,
				timeline: {
					durationMs,
					tracks: this.session.project.timeline.tracks.map((track) => ({
						...track,
						durationMs: track.durationMs ?? durationMs,
					})),
				},
			},
		} satisfies BrowserStudioVaultSession;

		await this.backend.updateSession(updatedSession);
		this.session = updatedSession;
		return this.getSession();
	}

	async attachVideo(videoId: string) {
		return this.updateSession({ videoId });
	}

	async updateStatus(status: BrowserStudioVaultStatus) {
		return this.updateSession({ status });
	}

	async flush() {
		await this.pendingWrite;
		if (this.writeError) throw this.writeError;
	}

	async recoverAssetBlob(assetId: string) {
		await this.pendingWrite;
		const persistedChunks = await this.backend.readChunks(
			this.sessionId,
			assetId,
		);
		const pendingChunks = [...this.pendingChunks.values()]
			.filter((chunk) => chunk.assetId === assetId)
			.map((chunk) => chunk.blob);
		const chunks = [...persistedChunks, ...pendingChunks];
		if (chunks.length === 0) return null;
		const asset = this.session.assets.find(
			(asset) => asset.assetId === assetId,
		);
		return new Blob(chunks, { type: asset?.mimeType ?? undefined });
	}

	async dispose() {
		if (this.disposed) return;

		this.disposed = true;
		this.pendingChunks.clear();
		this.pendingChunkBytes = 0;
		await this.pendingWrite;
		await this.backend.deleteSession(this.sessionId);
	}

	private enqueue<T>(task: () => Promise<T>) {
		const operation = this.pendingWrite.then(async () => {
			if (this.writeError) throw this.writeError;
			return task();
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

	private async updateSession(
		update: Partial<
			Pick<BrowserStudioVaultSession, "status" | "videoId" | "project">
		>,
	) {
		await this.flush();
		const updatedSession = {
			...this.session,
			...update,
			updatedAt: now(),
		} satisfies BrowserStudioVaultSession;

		await this.backend.updateSession(updatedSession);
		this.session = updatedSession;
		return this.getSession();
	}
}

export const canUseOpfsBrowserStudioVault = () =>
	typeof navigator !== "undefined" &&
	typeof (navigator.storage as BrowserStudioStorageManager | undefined)
		?.getDirectory === "function";

export const canUseBrowserStudioVault = () =>
	canUseOpfsBrowserStudioVault() ||
	(typeof window !== "undefined" && typeof indexedDB !== "undefined");

export const createBrowserStudioVaultBackend = () => {
	if (canUseOpfsBrowserStudioVault()) {
		return new OpfsBrowserStudioVaultBackend();
	}

	return new IndexedDbBrowserStudioVaultBackend();
};

export const recoverBrowserStudioVaultSessions = async (
	backend: BrowserStudioVaultBackend = createBrowserStudioVaultBackend(),
) => {
	await backend.initialize();
	const sessions = await backend.listSessions();
	return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
};

export const deleteBrowserStudioVaultSession = async (
	sessionId: string,
	backend: BrowserStudioVaultBackend = createBrowserStudioVaultBackend(),
) => {
	await backend.initialize();
	await backend.deleteSession(sessionId);
};

export const deleteUploadedBrowserStudioVaultSessions = async (
	backend: BrowserStudioVaultBackend = createBrowserStudioVaultBackend(),
) => {
	await backend.initialize();
	const sessions = await backend.listSessions();
	const uploadedSessions = sessions.filter(
		(session) => session.status === "uploaded" && session.videoId,
	);
	await Promise.all(
		uploadedSessions.map((session) => backend.deleteSession(session.sessionId)),
	);
	return uploadedSessions.length;
};
