import type { BrowserEditorMediaMetadata } from "../../../apps/web/lib/browser-editor-metadata";

const probes = new Map<string, Promise<BrowserEditorMediaMetadata>>();

function canceled(signal: AbortSignal) {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Canceled", "AbortError");
}

/// Probes each media URL once per page: the editor instance, the preview and
/// the startup prefetch all need the same container metadata.
export function probeBrowserMedia(
	url: string,
	signal?: AbortSignal,
): Promise<BrowserEditorMediaMetadata> {
	let probe = probes.get(url);
	if (!probe) {
		const controller = new AbortController();
		probe = import("../../../apps/web/lib/browser-editor-metadata").then(
			({ probeBrowserEditorMedia }) =>
				probeBrowserEditorMedia(url, controller.signal),
		);
		probes.set(url, probe);
		probe.catch(() => {
			if (probes.get(url) === probe) probes.delete(url);
		});
	}
	if (!signal) return probe;
	if (signal.aborted) return Promise.reject(canceled(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(canceled(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		probe.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
