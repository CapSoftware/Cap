export interface CapPlayerCaption {
	language: string;
	label: string;
	url: string;
}

export const sameCaptionsKey = (captions: readonly CapPlayerCaption[]) =>
	JSON.stringify(
		captions.map((caption) => [caption.language, caption.label, caption.url]),
	);

export const initialCaptions = (
	captions: readonly CapPlayerCaption[],
	on: boolean,
): string | null => (on ? (captions[0]?.language ?? null) : null);

export const toggledCaptions = (
	active: string | null,
	remembered: string | null,
	captions: readonly CapPlayerCaption[],
): string | null => {
	if (active !== null) return null;
	return captions.some((caption) => caption.language === remembered)
		? remembered
		: (captions[0]?.language ?? null);
};

const cueContent = (cue: TextTrackCue) =>
	typeof (cue as VTTCue).getCueAsHTML === "function"
		? ((cue as VTTCue).getCueAsHTML().textContent ?? "")
		: ((cue as VTTCue).text ?? "");

export const activeCueText = (cues: TextTrackCueList | null | undefined) => {
	if (!cues) return "";
	const lines: string[] = [];
	for (let index = 0; index < cues.length; index++) {
		const cue = cues[index];
		const text = cue ? cueContent(cue).trim() : "";
		if (text) lines.push(text);
	}
	return lines.join("\n");
};

// The file is handed to the <track> as a blob URL. A <track> only loads from
// another origin when its video sets crossorigin, and the playback URLs may sit
// on another origin than the page.
export const loadCaptionsFile = (
	cache: Map<string, Promise<string>>,
	url: string,
): Promise<string> => {
	const cached = cache.get(url);
	if (cached) return cached;
	const loading = fetch(url, { credentials: "omit" })
		.then(async (response) => {
			if (!response.ok) throw new Error(`Captions answered ${response.status}`);
			const text = await response.text();
			if (!text.trimStart().startsWith("WEBVTT")) {
				throw new Error("Captions are not WebVTT");
			}
			return URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
		})
		.catch((error: unknown) => {
			cache.delete(url);
			throw error;
		});
	cache.set(url, loading);
	return loading;
};

export const releaseCaptionsFiles = (cache: Map<string, Promise<string>>) => {
	for (const loading of cache.values()) {
		void loading.then(URL.revokeObjectURL, () => undefined);
	}
	cache.clear();
};
