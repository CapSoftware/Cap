import "@cap/ui-solid/main.css";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-700.css";
import "../../../apps/desktop/src/styles/theme.css";

import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { Toaster } from "solid-toast";
import type { PreparingEditorModel } from "../../../apps/desktop/src/routes/editor/preparing-editor-model";
import {
	onBrowserPreviewSettled,
	setBrowserEditorVideoId,
} from "./browser-frame-socket";
import { browserWebGpuPresentationWorks } from "./browser-gpu-probe";
import { probeBrowserMedia } from "./browser-media-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import { prefetchBrowserEditorSources } from "./browser-sources";
import {
	clearEditorImportedImages,
	serializeEditorProjectSnapshot,
} from "./editor-file-mapping";
import {
	prepareEditorPresetBackground,
	setEditorPresetAssetBase,
} from "./preset-backgrounds";
import {
	importEditorBrowserImage,
	PortEditorTransport,
	setEditorTransport,
} from "./tauri-bridge";
import { setEditorAssetBase } from "./tauri-core";
import { setEditorStoreNamespace } from "./tauri-store";
import {
	type EditorSocketCredential,
	setEditorFrameSocketCredential,
} from "./websocket";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		},
	},
});

let dispose: (() => void) | null = null;
let skeletonHandoff: (() => void) | null = null;
let skeletonDispose: (() => void) | null = null;
let errorDispose: (() => void) | null = null;
let skeletonModel: PreparingEditorModel | null = null;
let skeletonSequence = -1;
let preparingData: {
	title: string;
	durationSeconds: number;
	tracks: Array<"display" | "camera">;
} | null = null;
let mountGeneration = 0;
const [webErrorState, setWebErrorState] = createSignal({
	message: "",
	hasBrowserDraftConflict: false,
	restoringBrowserDraft: false,
});
let editorModulePromise: Promise<
	typeof import("../../../apps/desktop/src/routes/editor/Editor")
> | null = null;

function loadEditorModule() {
	if (!editorModulePromise) {
		editorModulePromise = import(
			"../../../apps/desktop/src/routes/editor/Editor"
		).catch((cause: unknown) => {
			editorModulePromise = null;
			throw cause;
		});
	}
	return editorModulePromise;
}

function updateSkeletonModel() {
	if (!skeletonModel || !preparingData) return;
	if (
		skeletonSequence < 0 &&
		!skeletonModel.bind(
			{ requestEpoch: 1, jobId: "web-preparing" },
			{ seek: async () => undefined, setPlaying: async () => undefined },
			30,
		)
	) {
		return;
	}
	skeletonModel.accept({
		requestEpoch: 1,
		jobId: "web-preparing",
		sequence: ++skeletonSequence,
		progress: {
			totalDuration: preparingData.durationSeconds,
			playableUntil: 0,
			previewAvailable: false,
			phase: "preparing",
		},
		playback: { playheadSeconds: 0, playing: false, buffering: false },
		seed: { title: preparingData.title, tracks: preparingData.tracks },
	});
}

async function mountEditorSkeleton(element: HTMLElement) {
	const generation = mountGeneration;
	const [{ EditorSkeleton }, { createPreparingEditorModel }] =
		await Promise.all([
			import("../../../apps/desktop/src/routes/editor/editor-skeleton"),
			import("../../../apps/desktop/src/routes/editor/preparing-editor-model"),
		]);
	if (generation !== mountGeneration || dispose || skeletonDispose) return;
	element.style.display = "";
	element.style.pointerEvents = "";
	skeletonDispose = render(() => {
		const model = createPreparingEditorModel();
		skeletonModel = model;
		onCleanup(() => {
			model.dispose();
			if (skeletonModel === model) skeletonModel = null;
		});
		updateSkeletonModel();
		return (
			<div class="flex h-screen w-screen flex-col bg-ed-window text-ed-text-1">
				<EditorSkeleton model={model} />
			</div>
		);
	}, element);
}

function disposeSkeleton() {
	skeletonHandoff?.();
	skeletonHandoff = null;
	skeletonDispose?.();
	skeletonDispose = null;
	skeletonModel = null;
	skeletonSequence = -1;
	if (skeletonRoot) {
		skeletonRoot.style.display = "none";
		skeletonRoot.style.opacity = "";
		skeletonRoot.style.transition = "";
	}
}

/// Keeps the loading skeleton over the mounted editor until the preview has
/// painted, so opening shows one loader instead of two.
function handOffSkeletonWhenPreviewSettles(generation: number) {
	skeletonHandoff?.();
	let timer = 0;
	const finish = () => {
		window.clearTimeout(timer);
		unsubscribe();
		if (generation !== mountGeneration) return;
		skeletonHandoff = null;
		if (
			!skeletonRoot ||
			matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			disposeSkeleton();
			return;
		}
		skeletonRoot.style.transition = "opacity 160ms ease-out";
		skeletonRoot.style.opacity = "0";
		skeletonRoot.style.pointerEvents = "none";
		window.setTimeout(() => {
			if (generation === mountGeneration && !skeletonHandoff) disposeSkeleton();
		}, 180);
	};
	const unsubscribe = onBrowserPreviewSettled(() =>
		requestAnimationFrame(finish),
	);
	timer = window.setTimeout(finish, 15_000);
	skeletonHandoff = () => {
		window.clearTimeout(timer);
		unsubscribe();
	};
}

export async function mountEditor(element: HTMLElement) {
	if (dispose) return;
	const generation = mountGeneration;
	const { Editor } = await loadEditorModule();
	if (generation !== mountGeneration)
		throw new Error("Editor mount was canceled");
	if (dispose) return;
	errorDispose?.();
	errorDispose = null;
	if (skeletonDispose) handOffSkeletonWhenPreviewSettles(generation);
	else disposeSkeleton();
	dispose = render(
		() => (
			<QueryClientProvider client={queryClient}>
				<Toaster position="bottom-right" />
				<div class="flex h-screen w-screen flex-col bg-ed-window text-ed-text-1">
					<Editor />
				</div>
			</QueryClientProvider>
		),
		element,
	);
}

export function disposeEditor() {
	mountGeneration++;
	dispose?.();
	dispose = null;
	disposeSkeleton();
	errorDispose?.();
	errorDispose = null;
	setEditorTransport(null);
	setBrowserEditorVideoId(null);
}

declare global {
	interface Window {
		capWebEditorCaptionsEnabled?: boolean;
		capWebEditorUserId?: string;
		capSolidEditor?: {
			mount: () => Promise<void>;
			dispose: () => void;
			unsavedProject: () => string | null;
		};
		capWebEditorUnsavedProjectSnapshot?: () => string | null;
		capWebEditorPreparePresetBackground?: (config: unknown) => Promise<void>;
	}
}

function layer(zIndex: number) {
	const element = document.createElement("div");
	element.style.cssText = `position:absolute;inset:0;z-index:${zIndex}`;
	return element;
}

/// Starts everything the first preview frame needs before the host connects:
/// the renderer module, the GPU check, the recording sources and media probes.
function prefetchStartup() {
	void loadBrowserRenderer().catch(() => undefined);
	void browserWebGpuPresentationWorks().catch(() => undefined);
	const videoId = new URLSearchParams(window.location.search).get("videoId");
	if (!videoId || !/^[A-Za-z0-9_-]{1,255}$/.test(videoId)) return;
	void prefetchBrowserEditorSources(videoId)
		.then((sources) => {
			const first = sources.segments[0];
			for (const url of [
				first?.display?.url,
				first?.camera?.url,
				sources.mic?.url,
			]) {
				if (url) void probeBrowserMedia(url).catch(() => undefined);
			}
		})
		.catch(() => undefined);
}

const container = document.getElementById("editor-root");
const root = container ? layer(0) : null;
const skeletonRoot = container ? layer(1) : null;
if (container && root && skeletonRoot) {
	container.style.cssText =
		"position:relative;width:100vw;height:100vh;overflow:hidden";
	container.append(root, skeletonRoot);
	prefetchStartup();
	void mountEditorSkeleton(skeletonRoot).catch(() => undefined);
	void loadEditorModule().catch(() => undefined);
	window.capSolidEditor = {
		mount: () => mountEditor(root),
		dispose: disposeEditor,
		unsavedProject: () => {
			const serialized = window.capWebEditorUnsavedProjectSnapshot?.();
			return serialized ? serializeEditorProjectSnapshot(serialized) : null;
		},
	};
	window.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (event.source !== window.parent) return;
		if (event.origin !== window.location.origin) return;
		if (typeof event.data !== "object" || event.data === null) return;
		const message = event.data as Record<string, unknown>;
		if (message.kind === "cap-editor-error" && message.version === 1) {
			if (
				typeof message.message !== "string" ||
				message.message.length < 1 ||
				message.message.length > 1000 ||
				typeof message.hasBrowserDraftConflict !== "boolean" ||
				typeof message.restoringBrowserDraft !== "boolean"
			)
				return;
			setWebErrorState({
				message: message.message,
				hasBrowserDraftConflict: message.hasBrowserDraftConflict,
				restoringBrowserDraft: message.restoringBrowserDraft,
			});
			if (errorDispose) {
				window.parent.postMessage(
					{ kind: "cap-editor-error-ready", version: 1 },
					window.location.origin,
				);
				return;
			}
			const generation = ++mountGeneration;
			dispose?.();
			dispose = null;
			disposeSkeleton();
			setEditorTransport(null);
			setBrowserEditorVideoId(null);
			window.capWebEditorPreparePresetBackground = undefined;
			void import("./web-editor-error-screen").then(
				({ WebEditorErrorScreen }) => {
					if (generation !== mountGeneration) return;
					errorDispose = render(
						() => (
							<div class="flex h-screen w-screen flex-col bg-ed-window text-ed-text-1">
								<WebEditorErrorScreen
									message={webErrorState().message}
									hasBrowserDraftConflict={
										webErrorState().hasBrowserDraftConflict
									}
									restoringBrowserDraft={webErrorState().restoringBrowserDraft}
									onAction={(action) =>
										window.parent.postMessage(
											{ kind: "cap-editor-error-action", version: 1, action },
											window.location.origin,
										)
									}
								/>
							</div>
						),
						root,
					);
					window.parent.postMessage(
						{ kind: "cap-editor-error-ready", version: 1 },
						window.location.origin,
					);
				},
				() =>
					window.parent.postMessage(
						{ kind: "cap-editor-error-failed", version: 1 },
						window.location.origin,
					),
			);
			return;
		}
		if (message.kind === "cap-editor-preparing" && message.version === 1) {
			if (
				typeof message.title !== "string" ||
				message.title.length > 255 ||
				typeof message.durationSeconds !== "number" ||
				!Number.isFinite(message.durationSeconds) ||
				message.durationSeconds <= 0 ||
				!Array.isArray(message.tracks) ||
				message.tracks.length < 1 ||
				message.tracks.length > 2 ||
				message.tracks[0] !== "display" ||
				(message.tracks.length === 2 && message.tracks[1] !== "camera")
			) {
				return;
			}
			preparingData = {
				title: message.title,
				durationSeconds: message.durationSeconds,
				tracks: message.tracks as Array<"display" | "camera">,
			};
			updateSkeletonModel();
			return;
		}
		if (message.kind !== "cap-editor-connect" || message.version !== 1) return;
		if (typeof message.videoId !== "string") return;
		const port = event.ports[0];
		if (!port) return;
		if (errorDispose || webErrorState().message) mountGeneration++;
		errorDispose?.();
		errorDispose = null;
		window.capWebEditorCaptionsEnabled = message.captionsEnabled === true;
		setBrowserEditorVideoId(message.videoId);
		window.capWebEditorUserId =
			typeof message.userId === "string" ? message.userId : "";
		setEditorStoreNamespace(
			typeof message.userId === "string" ? message.userId : "",
		);
		setEditorAssetBase(
			typeof message.assetBase === "string" ? message.assetBase : "",
		);
		setEditorPresetAssetBase(
			typeof message.assetBase === "string" ? message.assetBase : "",
		);
		clearEditorImportedImages();
		const frames = message.frames;
		setEditorFrameSocketCredential(
			typeof frames === "object" &&
				frames !== null &&
				"url" in frames &&
				"ticket" in frames &&
				typeof frames.url === "string" &&
				typeof frames.ticket === "string"
				? (frames as EditorSocketCredential)
				: null,
		);
		const browserSession =
			typeof message.browserSessionId === "string" &&
			message.browserSessionId.length > 0
				? {
						videoId: message.videoId,
						sessionId: message.browserSessionId,
					}
				: undefined;
		setEditorTransport(new PortEditorTransport(port, browserSession));
		window.capWebEditorPreparePresetBackground = (config) =>
			prepareEditorPresetBackground(
				window.capWebEditorUserId?.trim() || "anonymous",
				"store",
				config,
				importEditorBrowserImage,
			);
		void mountEditor(root).then(
			() => port.postMessage({ kind: "mount", status: "ready" }),
			() => port.postMessage({ kind: "mount", status: "error" }),
		);
	});
}
