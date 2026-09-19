import { randomUUID } from "node:crypto";
import { stripEditorCaptionContent } from "../../../web/lib/editor-caption-access";
import type { EditorAudioAsset } from "./editor-assets";
import { closeEditorCapImports } from "./editor-cap-imports";
import { closeEditorExports, editorExportActivityAt } from "./editor-exports";
import type { EditorImageAsset } from "./editor-image-assets";
import {
	downloadEditorMedia,
	type EditorMediaSource,
	inspectEditorDisplayMedia,
	resolveEditorFps,
} from "./editor-media";
import {
	type LegacyEditorEditSpec,
	type NativeEditorClipInput,
	type NativeEditorImport,
	type NativeEditorInputs,
	prepareNativeEditorProject,
	startNativeEditorSession,
} from "./editor-native";
import type { EditorVideoAsset } from "./editor-video-assets";
import { closeEditorVideoImports } from "./editor-video-imports";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_ATTACH_TIMEOUT_MS = 2 * 60 * 1000;
const PREPARATION_RETENTION_MS = 30 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 1;

function newEditorSessionId() {
	const workerId = process.env.CAP_WEB_EDITOR_WORKER_ID;
	if (!workerId) return randomUUID();
	if (!/^[a-z][a-z0-9-]{0,23}$/.test(workerId)) {
		throw new Error("Invalid editor worker ID");
	}
	return `${workerId}.${randomUUID()}`;
}

type Source = EditorMediaSource & { fps?: number };

export type EditorSessionInput = {
	videoId: string;
	title: string;
	captionsEnabled: boolean;
	display: Source;
	camera?: Source & { offsetMs: number };
	projectConfig?: Record<string, unknown>;
	legacyEditSpec?: LegacyEditorEditSpec;
	audioAssets?: EditorAudioAsset[];
	imageAssets?: EditorImageAsset[];
	videoAssets?: EditorVideoAsset[];
	clips?: NativeEditorClipInput[];
	imports?: NativeEditorImport[];
};

type NativeSession = Awaited<ReturnType<typeof startNativeEditorSession>>;

type Session = {
	id: string;
	videoId: string;
	native: NativeSession & { captionsEnabled: boolean };
	lastActive: number;
	readyAt: number;
	attached: boolean;
};

const sessions = new Map<string, Session>();
const closingSessions = new Map<string, Promise<boolean>>();

function editorSessionExpired(session: Session, now: number) {
	const lastActive = Math.max(
		session.lastActive,
		editorExportActivityAt(session.id, now) ?? 0,
	);
	return (
		now - lastActive > IDLE_TIMEOUT_MS ||
		(!session.attached && now - session.readyAt > SESSION_ATTACH_TIMEOUT_MS)
	);
}

async function reclaimExpiredEditorSessions() {
	const now = Date.now();
	const expired = [...sessions.values()].filter((session) =>
		editorSessionExpired(session, now),
	);
	await Promise.all([
		...closingSessions.values(),
		...expired.map((session) => closeEditorSession(session.id)),
	]);
}

type Preparation = {
	id: string;
	videoId: string;
	status: "preparing" | "ready" | "error" | "canceled" | "closed";
	sessionId?: string;
	controller: AbortController;
	task?: Promise<void>;
	updatedAt: number;
};
const preparations = new Map<string, Preparation>();
let starting = 0;

export class EditorSessionBusyError extends Error {}

export async function createEditorSession(
	input: EditorSessionInput,
	abortSignal?: AbortSignal,
) {
	if (sessions.size + starting >= MAX_ACTIVE_SESSIONS) {
		throw new EditorSessionBusyError("Editor render capacity is busy");
	}
	starting++;
	try {
		const [displayResult, cameraResult] = await Promise.allSettled([
			downloadEditorMedia(input.display, abortSignal),
			input.camera
				? downloadEditorMedia(input.camera, abortSignal)
				: Promise.resolve(null),
		]);
		if (
			displayResult.status === "rejected" ||
			cameraResult.status === "rejected"
		) {
			await Promise.all([
				displayResult.status === "fulfilled"
					? displayResult.value.cleanup()
					: Promise.resolve(),
				cameraResult.status === "fulfilled" && cameraResult.value
					? cameraResult.value.cleanup()
					: Promise.resolve(),
			]);
			throw displayResult.status === "rejected"
				? displayResult.reason
				: cameraResult.status === "rejected"
					? cameraResult.reason
					: new Error("Editor source unavailable");
		}
		const display = displayResult.value;
		const camera = cameraResult.value;
		let project: Awaited<ReturnType<typeof prepareNativeEditorProject>>;
		try {
			const [displayMedia, cameraFps] = await Promise.all([
				inspectEditorDisplayMedia(display.path, input.display.fps),
				camera
					? resolveEditorFps(camera.path, input.camera?.fps)
					: Promise.resolve(null),
			]);
			if (
				input.legacyEditSpec &&
				(!Number.isFinite(displayMedia.duration) ||
					Math.abs(
						displayMedia.duration - input.legacyEditSpec.sourceDuration,
					) > 0.75)
			) {
				throw new Error(
					"The preserved edit source does not match its timeline",
				);
			}
			const inputs: NativeEditorInputs = {
				title: input.title,
				display: {
					path: display.path,
					contentType: input.display.contentType,
					size: display.size,
					fps: displayMedia.fps,
				},
				...(camera && input.camera
					? {
							camera: {
								path: camera.path,
								contentType: input.camera.contentType,
								size: camera.size,
								fps: cameraFps ?? displayMedia.fps,
								offsetMs: input.camera.offsetMs,
							},
						}
					: {}),
				mixedAudioInDisplay: displayMedia.hasAudio,
				...(input.legacyEditSpec
					? { legacyEditSpec: input.legacyEditSpec }
					: {}),
				...(input.projectConfig
					? {
							projectConfig: input.captionsEnabled
								? input.projectConfig
								: stripEditorCaptionContent(input.projectConfig),
						}
					: {}),
				...(input.audioAssets ? { audioAssets: input.audioAssets } : {}),
				...(input.imageAssets ? { imageAssets: input.imageAssets } : {}),
				...(input.videoAssets ? { videoAssets: input.videoAssets } : {}),
				...(input.clips ? { clips: input.clips } : {}),
				...(input.imports ? { imports: input.imports } : {}),
			};
			if (abortSignal?.aborted) throw new Error("Editor preparation canceled");
			project = await prepareNativeEditorProject(inputs, abortSignal);
		} finally {
			await Promise.all([
				display.cleanup(),
				camera?.cleanup() ?? Promise.resolve(),
			]);
		}
		if (abortSignal?.aborted) {
			await project.cleanup();
			throw new Error("Editor preparation canceled");
		}
		const nativeSession = await startNativeEditorSession(project);
		const native = {
			...nativeSession,
			captionsEnabled: input.captionsEnabled,
		};
		if (abortSignal?.aborted) {
			await native.close();
			throw new Error("Editor preparation canceled");
		}
		const readyAt = Date.now();
		const session: Session = {
			id: newEditorSessionId(),
			videoId: input.videoId,
			native,
			lastActive: readyAt,
			readyAt,
			attached: false,
		};
		sessions.set(session.id, session);
		return session.id;
	} finally {
		starting--;
	}
}

export async function beginEditorPreparation(input: EditorSessionInput) {
	await reclaimExpiredEditorSessions();
	if (sessions.size + starting >= MAX_ACTIVE_SESSIONS) {
		throw new EditorSessionBusyError("Editor render capacity is busy");
	}
	const preparation: Preparation = {
		id: newEditorSessionId(),
		videoId: input.videoId,
		status: "preparing",
		controller: new AbortController(),
		updatedAt: Date.now(),
	};
	preparations.set(preparation.id, preparation);
	preparation.task = createEditorSession(input, preparation.controller.signal)
		.then(async (sessionId) => {
			if (preparation.controller.signal.aborted) {
				await closeEditorSession(sessionId);
				preparation.status = "canceled";
			} else {
				preparation.status = "ready";
				preparation.sessionId = sessionId;
			}
			preparation.updatedAt = Date.now();
		})
		.catch((error) => {
			if (!preparation.controller.signal.aborted) {
				console.error("Editor preparation failed", error);
				preparation.status = "error";
			}
			preparation.updatedAt = Date.now();
		});
	return preparation.id;
}

export function getEditorPreparation(id: string) {
	const preparation = preparations.get(id);
	if (!preparation) return null;
	if (
		preparation.status === "ready" &&
		preparation.sessionId &&
		!getEditorSessionVideoId(preparation.sessionId)
	) {
		preparation.status = "closed";
		preparation.updatedAt = Date.now();
	}
	return {
		videoId: preparation.videoId,
		status: preparation.status,
		...(preparation.sessionId ? { sessionId: preparation.sessionId } : {}),
	};
}

export function getEditorSessionVideoId(id: string) {
	const session = sessions.get(id);
	if (!session) return null;
	if (editorSessionExpired(session, Date.now())) {
		void closeEditorSession(id).catch((error) => {
			console.error("Expired editor session cleanup failed", error);
		});
		return null;
	}
	return session.videoId;
}

export function cancelEditorPreparation(id: string) {
	const preparation = preparations.get(id);
	if (!preparation) return false;
	preparation.controller.abort();
	preparation.updatedAt = Date.now();
	if (preparation.sessionId) {
		void closeEditorSession(preparation.sessionId).catch((error) => {
			console.error("Editor session cancellation failed", error);
		});
	}
	preparation.status = "canceled";
	return true;
}

export function getEditorSession(id: string) {
	const session = sessions.get(id);
	if (!session) return null;
	const now = Date.now();
	if (editorSessionExpired(session, now)) {
		void closeEditorSession(id).catch((error) => {
			console.error("Expired editor session cleanup failed", error);
		});
		return null;
	}
	session.lastActive = now;
	return session.native;
}

export function attachEditorSession(id: string) {
	if (!getEditorSession(id)) return false;
	const session = sessions.get(id);
	if (!session) return false;
	session.attached = true;
	return true;
}

export async function closeEditorSession(id: string) {
	const closing = closingSessions.get(id);
	if (closing) return closing;
	const session = sessions.get(id);
	if (!session) return false;
	sessions.delete(id);
	for (const preparation of preparations.values()) {
		if (preparation.sessionId === id && preparation.status === "ready") {
			preparation.status = "closed";
			preparation.updatedAt = Date.now();
		}
	}
	const task = (async () => {
		try {
			await Promise.all([
				closeEditorExports(id),
				closeEditorVideoImports(id),
				closeEditorCapImports(id),
			]);
		} finally {
			try {
				await session.native.close();
			} finally {
				closingSessions.delete(id);
			}
		}
		return true;
	})();
	closingSessions.set(id, task);
	return task;
}

export async function closeAllEditorSessions() {
	for (const preparation of preparations.values()) {
		preparation.controller.abort();
	}
	await Promise.all(
		[...preparations.values()].map(
			(preparation) => preparation.task ?? Promise.resolve(),
		),
	);
	await Promise.all([
		...closingSessions.values(),
		...[...sessions.keys()].map(closeEditorSession),
	]);
}

const sweep = setInterval(() => {
	const now = Date.now();
	for (const preparation of preparations.values()) {
		if (now - preparation.updatedAt > PREPARATION_RETENTION_MS) {
			if (preparation.status === "preparing") {
				preparation.controller.abort();
			}
			preparations.delete(preparation.id);
		}
	}
	for (const session of sessions.values()) {
		if (editorSessionExpired(session, now)) {
			void closeEditorSession(session.id).catch((error) => {
				console.error("Editor session cleanup failed", error);
			});
		}
	}
}, 60_000);
sweep.unref();
