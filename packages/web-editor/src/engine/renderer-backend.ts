import { createSignal } from "solid-js";

const [previewBackend, setPreviewBackend] = createSignal<string | null>(null);

export { previewBackend, setPreviewBackend };

/// The WebGL2 renderer can't draw the audio visualizer, so it is only offered
/// once the preview knows it is running on WebGPU.
export function audioVisualizerSupported() {
	return previewBackend() === "BrowserWebGpu";
}
