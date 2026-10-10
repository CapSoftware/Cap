type RendererModule =
	typeof import("../renderer/pkg/cap_editor_browser_renderer.js");

let pending: Promise<RendererModule> | null = null;

/// The wasm request index.html starts with the page, taken once: a retry
/// after a failed load asks for the file afresh.
function takeEarlyWasm() {
	const scope = globalThis as { __capRendererWasm?: Promise<Response> };
	const early = scope.__capRendererWasm;
	delete scope.__capRendererWasm;
	return early;
}

export function loadBrowserRenderer(): Promise<RendererModule> {
	if (!pending) {
		pending = import("../renderer/pkg/cap_editor_browser_renderer.js")
			.then(async (module) => {
				const early = takeEarlyWasm();
				await module.default(early ? { module_or_path: early } : undefined);
				return module;
			})
			.catch((error: unknown) => {
				pending = null;
				throw error;
			});
	}
	return pending;
}
