import type { Input } from "mediabunny";

type SharedInput = { input: Promise<Input>; users: number };

const shared = new Map<string, SharedInput>();

/// One mediabunny Input per recording URL for the whole page, so the preview's
/// decoder and one-off frame reads (clip thumbnails) share the bytes and the
/// fragment positions already read instead of each walking the file again.
/// Call `release` once done; the Input closes when its last user releases it.
export async function acquireMediaInput(url: string) {
	let entry = shared.get(url);
	if (!entry) {
		entry = {
			input: import("mediabunny").then(
				({ ALL_FORMATS, Input, UrlSource }) =>
					new Input({
						formats: ALL_FORMATS,
						// Seconds of Retina screen video; a smaller cache drops data a
						// seek comes back for, and every seek then refetches it.
						source: new UrlSource(url, { maxCacheSize: 32 * 1024 * 1024 }),
					}),
			),
			users: 0,
		};
		shared.set(url, entry);
	}
	const current = entry;
	current.users++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		current.users--;
		if (current.users > 0) return;
		if (shared.get(url) === current) shared.delete(url);
		void current.input.then(
			(input) => input.dispose(),
			() => undefined,
		);
	};
	try {
		return { input: await current.input, release };
	} catch (cause) {
		release();
		throw cause;
	}
}
