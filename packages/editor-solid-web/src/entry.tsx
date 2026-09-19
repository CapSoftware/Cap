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
import { serializeEditorProjectSnapshot } from "./editor-file-mapping";
import { PortEditorTransport, setEditorTransport } from "./tauri-bridge";
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

export async function mountEditor(element: HTMLElement) {
	if (dispose) return;
	const generation = mountGeneration;
	const { Editor } = await loadEditorModule();
	if (generation !== mountGeneration)
		throw new Error("Editor mount was canceled");
	if (dispose) return;
	skeletonDispose?.();
	skeletonDispose = null;
	errorDispose?.();
	errorDispose = null;
	skeletonModel = null;
	skeletonSequence = -1;
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
	skeletonDispose?.();
	skeletonDispose = null;
	errorDispose?.();
	errorDispose = null;
	skeletonModel = null;
	skeletonSequence = -1;
	setEditorTransport(null);
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
	}
}

const root = document.getElementById("editor-root");
if (root) {
	void mountEditorSkeleton(root).catch(() => undefined);
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
			skeletonDispose?.();
			skeletonDispose = null;
			skeletonModel = null;
			skeletonSequence = -1;
			setEditorTransport(null);
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
		const port = event.ports[0];
		if (!port) return;
		if (errorDispose || webErrorState().message) mountGeneration++;
		errorDispose?.();
		errorDispose = null;
		window.capWebEditorCaptionsEnabled = message.captionsEnabled === true;
		window.capWebEditorUserId =
			typeof message.userId === "string" ? message.userId : "";
		setEditorStoreNamespace(
			typeof message.userId === "string" ? message.userId : "",
		);
		setEditorAssetBase(
			typeof message.assetBase === "string" ? message.assetBase : "",
		);
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
		setEditorTransport(new PortEditorTransport(port));
		void mountEditor(root).then(
			() => port.postMessage({ kind: "mount", status: "ready" }),
			() => port.postMessage({ kind: "mount", status: "error" }),
		);
	});
}
