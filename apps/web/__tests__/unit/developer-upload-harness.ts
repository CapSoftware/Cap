import type { Effect as EffectType } from "effect";
import { vi } from "vitest";

export type StoredVideo = {
	appId: string;
	duration: number | null;
	deletedAt: string | null;
	status: string;
};

export type StoredKey = { appId: string; revokedAt: string | null };

export const state = {
	query: vi.fn(),
	videos: new Map<string, StoredVideo>(),
	keys: new Map<string, StoredKey | null>(),
	apps: new Set<string>(),
	environment: "production",
	nextVideo: 0,
	nextKey: 0,
	admission: vi.fn(),
	claim: vi.fn(),
	release: vi.fn(),
	startProcessing: vi.fn(),
	create: vi.fn(),
	presign: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
	listUploads: vi.fn(),
	listParts: vi.fn(),
};

const admitted = {
	allowed: true,
	reason: null,
	standing: { state: "active", pausesAt: null },
	balanceMicroCredits: 1_000_000,
	requiredMicroCredits: 1,
	shortfallMicroCredits: 0,
	message: null,
};

const KEY_TYPES: Record<string, string> = { cpk: "public", csk: "secret" };

export const keyIdOf = (key: string) => key.replace(/^c[ps]k_/, "key_");

function storedKey(key: string, appId: string) {
	const id = keyIdOf(key);
	if (!state.keys.has(id)) state.keys.set(id, { appId, revokedAt: null });
	return state.keys.get(id) ?? null;
}

export function revokeKey(key: string) {
	const stored = state.keys.get(keyIdOf(key));
	if (stored) stored.revokedAt = "2026-11-12 10:00:01";
}

export const removeKey = (key: string) => state.keys.set(keyIdOf(key), null);

const revokedTime = (revokedAt: string) =>
	Date.parse(`${revokedAt.replace(" ", "T")}Z`);

async function answer(query: string, params: unknown[]) {
	if (
		query.includes("from `developer_api_keys`") &&
		query.includes("`developer_api_keys`.`revokedAt` > ?")
	) {
		const [appId, , since] = params;
		const sinceTime = new Date(since as Date | string).getTime();
		const revoked = [...state.keys.entries()].find(([, key]) => {
			if (!key || key.appId !== appId || key.revokedAt === null) return false;
			return revokedTime(key.revokedAt) > sinceTime;
		});
		return { rows: revoked ? [[revoked[0]]] : [] };
	}
	if (query.includes("from `developer_api_keys`")) {
		const key = String(params[0]).replace("hash:", "");
		const [prefix = "", appId = ""] = key.split("_");
		if (KEY_TYPES[prefix] !== params[1] || !state.apps.has(appId)) {
			return { rows: [] };
		}
		const stored = storedKey(key, appId);
		if (!stored || stored.revokedAt) return { rows: [] };
		return { rows: [[appId, keyIdOf(key)]] };
	}
	if (query.includes("from `developer_videos` inner join `developer_apps`")) {
		const [keyId, , videoId, appId] = params;
		const video = state.videos.get(String(videoId));
		if (!video || video.appId !== appId || !state.apps.has(video.appId)) {
			return { rows: [] };
		}
		const key = state.keys.get(String(keyId));
		return {
			rows: [
				key && key.appId === video.appId
					? [video.duration, video.deletedAt, keyId, key.revokedAt]
					: [video.duration, video.deletedAt, null, null],
			],
		};
	}
	if (query.includes("from `developer_app_domains`")) {
		return { rows: [["domain-1"]] };
	}
	if (query.includes("from `developer_apps`")) {
		return { rows: state.apps.has(String(params[0])) ? [[params[0]]] : [] };
	}
	if (query.includes("from `developer_credit_accounts`")) {
		return { rows: [["account-1"]] };
	}
	if (query.startsWith("insert into `developer_videos`")) {
		state.videos.set(String(params[0]), {
			appId: String(params[1]),
			duration: null,
			deletedAt: null,
			status: "uploading",
		});
		return { rows: [{ affectedRows: 1 }] };
	}
	if (query.startsWith("update `developer_videos`")) {
		const video = state.videos.get(String(params.at(-1)));
		if (video && query.includes("`duration` = ?")) video.duration = 12;
		return { rows: [{ affectedRows: 1 }] };
	}
	if (query.includes("from `developer_videos`")) {
		const video = state.videos.get(String(params[0]));
		if (!video) return { rows: [] };
		if (/^select `duration` from/i.test(query)) {
			return { rows: [[video.duration]] };
		}
		if (/^select `duration`, `deletedAt` from/i.test(query)) {
			return { rows: [[video.duration, video.deletedAt]] };
		}
		return {
			rows: [
				[
					video.appId,
					`developer/${video.appId}/${params[0]}/video`,
					video.duration,
					video.deletedAt,
					"1080p",
					video.status,
				],
			],
		};
	}
	return { rows: [{ affectedRows: 1 }] };
}

export function resetUploadHarness() {
	vi.clearAllMocks();
	state.listUploads.mockReset();
	state.listParts.mockReset();
	state.presign.mockReset();
	state.videos.clear();
	state.keys.clear();
	state.apps = new Set(["app1", "app2"]);
	state.environment = "production";
	state.nextVideo = 0;
	state.query.mockImplementation(answer);
	state.admission.mockResolvedValue(admitted);
	state.claim.mockResolvedValue({ action: "start", encodeId: "encode-1" });
	state.startProcessing.mockResolvedValue(true);
	state.release.mockResolvedValue(undefined);
}

export const secretKey = (appId: string) => `csk_${appId}_${++state.nextKey}`;

export const videoWrites = () =>
	state.query.mock.calls.filter(([query]) =>
		/^(insert into|update|delete from) `developer_videos`/.test(String(query)),
	);

export const storageCalls = () =>
	state.create.mock.calls.length +
	state.presign.mock.calls.length +
	state.complete.mock.calls.length +
	state.abort.mock.calls.length;

export async function databaseMock() {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle((query, params) => state.query(query, params));
	const transaction = (run: (tx: typeof database) => unknown) => run(database);
	return { db: () => Object.assign(database, { transaction }) };
}

export async function storageMock() {
	const { Effect } = await import("effect");
	const { S3Error } = await import("@cap/web-domain");
	const storage = (call: () => unknown) =>
		Effect.try({ try: call, catch: (cause) => new S3Error({ cause }) });
	const multipart = {
		create: (...args: unknown[]) =>
			storage(() => state.create(...args) ?? { UploadId: "upload-1" }),
		getPresignedUploadPartUrl: (...args: unknown[]) =>
			storage(() => state.presign(...args) ?? "https://storage.test/part"),
		complete: (...args: unknown[]) => storage(() => state.complete(...args)),
		abort: (...args: unknown[]) => storage(() => state.abort(...args)),
		listUploads: (...args: unknown[]) =>
			storage(() => state.listUploads(...args) ?? { Uploads: [] }),
		listParts: (...args: unknown[]) =>
			storage(
				() =>
					state.listParts(...args) ?? [
						{ PartNumber: 1, ETag: '"etag-1"', Size: 1_048_576 },
					],
			),
	};
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		S3Buckets: {
			getBucketAccess: () => Effect.succeed([{ multipart }]),
		},
	};
}

export async function serverMock() {
	const { Cause, Effect, Exit } = await import("effect");
	return {
		runPromise: <A, E>(effect: EffectType.Effect<A, E>) =>
			Effect.runPromiseExit(effect).then((exit) => {
				if (Exit.isFailure(exit)) {
					if (Cause.isDieType(exit.cause)) throw exit.cause.defect;
					throw exit;
				}
				return exit.value;
			}),
	};
}

export const ORIGIN = "https://cap.test";

export const UPLOAD_ROUTES = [
	["initiate", {}],
	["presign-part", { uploadId: "upload-1", partNumber: 1 }],
	[
		"complete",
		{
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: "etag-1", size: 1_048_576 }],
			durationInSecs: 12,
		},
	],
	["abort", { uploadId: "upload-1" }],
] as const;

type Handlers = { POST: (request: Request) => unknown };

export function post(
	routes: Handlers,
	path: string,
	credential: string | null,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	return routes.POST(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(credential ? { Authorization: `Bearer ${credential}` } : {}),
				...headers,
			},
			body: JSON.stringify(body),
		}),
	) as Promise<Response>;
}
