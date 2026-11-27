import type { BrowserEditorMediaMetadata } from "./browser-editor-metadata";
import { acquireMediaInput, mediaSource } from "./browser-media-inputs";

const probes = new Map<string, Promise<BrowserEditorMediaMetadata>>();
const probed = new Map<string, BrowserEditorMediaMetadata>();

/// A finished probe's result, or null while it is pending or failed.
export function probedBrowserMedia(url: string) {
	return probed.get(url) ?? null;
}

function canceled(signal: AbortSignal) {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Canceled", "AbortError");
}

async function probe(url: string, signal: AbortSignal) {
	const { probeBrowserEditorMedia } = await import("./browser-editor-metadata");
	const media = mediaSource(url);
	if (!media) return probeBrowserEditorMedia(url, signal);
	// The preview decodes from this same Input, so its metadata is read once.
	const lease = await acquireMediaInput(url);
	// Tail reads follow the ones the seek index makes, starting with the one
	// opening the file made, so each length is read once for both.
	const steps = media.tailSteps();
	let call = 0;
	try {
		return await probeBrowserEditorMedia(url, signal, {
			input: lease.input,
			bytes: {
				head: () => media.head(),
				tail: async (length) => {
					const wanted = Math.min(length, steps[call] ?? length);
					call++;
					const [bytes, size] = await Promise.all([
						media.tail(wanted),
						media.fileSize(),
					]);
					return bytes ? { bytes, size } : null;
				},
			},
		});
	} finally {
		lease.release();
	}
}

/// Probes each media URL once per page: the editor instance, the preview and
/// the startup prefetch all need the same container metadata.
export function probeBrowserMedia(
	url: string,
	signal?: AbortSignal,
): Promise<BrowserEditorMediaMetadata> {
	let pending = probes.get(url);
	if (!pending) {
		const controller = new AbortController();
		pending = probe(url, controller.signal);
		probes.set(url, pending);
		const created = pending;
		created.then(
			(value) => {
				if (probes.get(url) === created) probed.set(url, value);
			},
			() => {
				if (probes.get(url) === created) probes.delete(url);
			},
		);
	}
	if (!signal) return pending;
	if (signal.aborted) return Promise.reject(canceled(signal));
	const shared = pending;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(canceled(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		shared.then(
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
