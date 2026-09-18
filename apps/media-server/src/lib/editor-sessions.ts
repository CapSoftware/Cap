import { randomUUID } from "node:crypto";
import { stripEditorCaptionContent } from "../../../web/lib/editor-caption-access";
import type { EditorAudioAsset } from "./editor-assets";
import { closeEditorCapImports } from "./editor-cap-imports";
import { closeEditorExports } from "./editor-exports";
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
};

const sessions = new Map<string, Session>();
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
		const session: Session = {
			id: newEditorSessionId(),
			videoId: input.videoId,
			native,
			lastActive: Date.now(),
		};
		sessions.set(session.id, session);
		return session.id;
	} finally {
		starting--;
	}
}

export function beginEditorPreparation(input: EditorSessionInput) {
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
	return {
		videoId: preparation.videoId,
		status: preparation.status,
		...(preparation.sessionId ? { sessionId: preparation.sessionId } : {}),
	};
}

export function getEditorSessionVideoId(id: string) {
	return sessions.get(id)?.videoId ?? null;
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
	if (Date.now() - session.lastActive > IDLE_TIMEOUT_MS) {
		void closeEditorSession(id);
		return null;
	}
	session.lastActive = Date.now();
	return session.native;
}

export async function closeEditorSession(id: string) {
	const session = sessions.get(id);
	if (!session) return false;
	sessions.delete(id);
	for (const preparation of preparations.values()) {
		if (preparation.sessionId === id && preparation.status === "ready") {
			preparation.status = "closed";
			preparation.updatedAt = Date.now();
		}
	}
	try {
		await Promise.all([
			closeEditorExports(id),
			closeEditorVideoImports(id),
			closeEditorCapImports(id),
		]);
	} finally {
		await session.native.close();
	}
	return true;
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
	await Promise.all([...sessions.keys()].map(closeEditorSession));
}

const sweep = setInterval(() => {
	for (const preparation of preparations.values()) {
		if (Date.now() - preparation.updatedAt > PREPARATION_RETENTION_MS) {
			if (preparation.status === "preparing") {
				preparation.controller.abort();
			}
			preparations.delete(preparation.id);
		}
	}
	for (const session of sessions.values()) {
		if (Date.now() - session.lastActive > IDLE_TIMEOUT_MS) {
			void closeEditorSession(session.id).catch((error) => {
				console.error("Editor session cleanup failed", error);
			});
		}
	}
}, 60_000);
sweep.unref();
