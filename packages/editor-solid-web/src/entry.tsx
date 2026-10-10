import "@cap/ui-solid/main.css";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-700.css";
import "../../../apps/desktop/src/styles/theme.css";
import "./web-app.css";

import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { Toaster } from "solid-toast";
import {
	clearPlayRequest,
	requestPlayWhenReady,
} from "../../../apps/desktop/src/routes/editor/playback-buffering";
import { frameDisplayGamma } from "./browser-color-calibration";
import { startConnectionReport } from "./browser-connection-report";
import { setBrowserEditorVideoId } from "./browser-frame-socket";
import { browserWebGpuPresentationWorks } from "./browser-gpu-probe";
import { releaseMediaSources, warmMediaSource } from "./browser-media-inputs";
import { probeBrowserMedia } from "./browser-media-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import {
	prefetchBrowserEditorSources,
	releaseBrowserEditorSources,
} from "./browser-sources";
import {
	prefetchWebInputRecording,
	releaseWebInputRecordings,
} from "./browser-studio-setup";
import {
	clearEditorImportedImages,
	serializeEditorProjectSnapshot,
} from "./editor-file-mapping";
import { perfMark } from "./editor-perf";
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
let errorDispose: (() => void) | null = null;
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

export async function mountEditor(element: HTMLElement) {
	if (dispose) return;
	const generation = mountGeneration;
	const { Editor } = await loadEditorModule();
	perfMark("editor-module");
	if (generation !== mountGeneration)
		throw new Error("Editor mount was canceled");
	if (dispose) return;
	errorDispose?.();
	errorDispose = null;
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
	perfMark("editor-mounted");
}

export function disposeEditor() {
	mountGeneration++;
	dispose?.();
	dispose = null;
	clearPlayRequest();
	releaseRecordingData();
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
			unpublishedEdits: () => boolean;
			savingHere: () => boolean;
		};
		capWebEditorUnsavedProjectSnapshot?: () => string | null;
		capWebEditorUnpublishedEdits?: () => boolean;
		capWebEditorSavingHere?: () => boolean;
		capWebEditorPreparePresetBackground?: (config: unknown) => Promise<void>;
	}
}

/// Everything loaded for the editor's recording, dropped when it is torn down
/// so a long-lived frame does not keep another recording's bytes.
function releaseRecordingData() {
	releaseBrowserEditorSources();
	releaseMediaSources();
	releaseWebInputRecordings();
}

/// Starts everything the first preview frame needs before the host connects:
/// the renderer module, the GPU check, the recording sources and media probes.
function prefetchStartup() {
	void loadBrowserRenderer().catch(() => undefined);
	void browserWebGpuPresentationWorks()
		.then((works) => {
			if (works) void frameDisplayGamma();
		})
		.catch(() => undefined);
	const videoId = new URLSearchParams(window.location.search).get("videoId");
	if (!videoId || !/^[A-Za-z0-9_-]{1,255}$/.test(videoId)) return;
	void prefetchBrowserEditorSources(videoId)
		.then((sources) => {
			prefetchWebInputRecording(sources);
			const first = sources.segments[0];
			for (const source of [
				first?.display,
				first?.camera,
				sources.mic,
				sources.systemAudio,
			]) {
				if (!source) continue;
				warmMediaSource(source.url, source.size ?? null);
				void probeBrowserMedia(source.url).catch(() => undefined);
			}
		})
		.catch(() => undefined);
}

/// A hidden copy of this page loads while someone records or browses their
/// projects, so the editor code and renderer are cached before it opens.
function prewarm() {
	void Promise.allSettled([loadBrowserRenderer(), loadEditorModule()]).then(
		() =>
			window.parent.postMessage(
				{ kind: "cap-editor-prewarmed", version: 1 },
				window.location.origin,
			),
	);
}

/// Pinch and ctrl+scroll zoom the timeline or the preview, never the page.
function guardPageZoom() {
	window.addEventListener(
		"wheel",
		(event) => {
			if (event.ctrlKey) event.preventDefault();
		},
		{ passive: false },
	);
	for (const type of ["gesturestart", "gesturechange"]) {
		window.addEventListener(type, (event) => event.preventDefault(), {
			passive: false,
		});
	}
	window.addEventListener("keydown", (event) => {
		if (
			(event.metaKey || event.ctrlKey) &&
			["=", "+", "-", "0"].includes(event.key)
		) {
			event.preventDefault();
		}
	});
}

const prewarming =
	window.parent !== window &&
	new URLSearchParams(window.location.search).has("prewarm");
const root = prewarming ? null : document.getElementById("editor-root");
if (prewarming) {
	prewarm();
} else if (root) {
	perfMark("entry");
	guardPageZoom();
	root.style.cssText = "width:100vw;height:100vh;overflow:hidden";
	prefetchStartup();
	startConnectionReport(window.parent === window ? null : window.parent);
	void loadEditorModule().catch(() => undefined);
	window.capSolidEditor = {
		mount: () => mountEditor(root),
		dispose: disposeEditor,
		unsavedProject: () => {
			const serialized = window.capWebEditorUnsavedProjectSnapshot?.();
			return serialized ? serializeEditorProjectSnapshot(serialized) : null;
		},
		unpublishedEdits: () => window.capWebEditorUnpublishedEdits?.() === true,
		savingHere: () => window.capWebEditorSavingHere?.() === true,
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
			clearPlayRequest();
			releaseRecordingData();
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
		if (message.kind === "cap-editor-play-request" && message.version === 1) {
			if (typeof message.playing === "boolean")
				requestPlayWhenReady(message.playing);
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
