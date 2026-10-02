type RendererModule =
	typeof import("../renderer/pkg/cap_editor_browser_renderer.js");

let pending: Promise<RendererModule> | null = null;

export function loadBrowserRenderer(): Promise<RendererModule> {
	if (!pending) {
		pending = import("../renderer/pkg/cap_editor_browser_renderer.js")
			.then(async (module) => {
				await module.default();
				return module;
			})
			.catch((error: unknown) => {
				pending = null;
				throw error;
			});
	}
	return pending;
}
