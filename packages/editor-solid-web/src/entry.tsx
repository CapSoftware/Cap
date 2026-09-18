import "@cap/ui-solid/main.css";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-700.css";
import "../../../apps/desktop/src/styles/theme.css";

import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";
import { Toaster } from "solid-toast";
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
let mountGeneration = 0;
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
	if (generation !== mountGeneration)
		throw new Error("Editor mount was canceled");
	if (dispose) return;
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
		if (message.kind !== "cap-editor-connect" || message.version !== 1) return;
		const port = event.ports[0];
		if (!port) return;
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
