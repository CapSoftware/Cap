import { buildEmbedQuery, type EmbedOptions } from "@/lib/embed-options";

/**
 * The `<iframe>` snippet handed out by every "Embed" surface. Shared so the
 * dashboard's sharing dialog and the share page's share dialog can't drift
 * apart — an embed that works in one place and not the other is the kind of
 * bug nobody reports, they just stop embedding.
 */
export const buildEmbedCode = ({
	webUrl,
	videoId,
	startTime,
	options,
}: {
	webUrl: string;
	videoId: string;
	/** Seconds to start playback at, if the sharer picked a moment. */
	startTime?: number | null;
	options?: Partial<Omit<EmbedOptions, "startTime">>;
}): string => {
	const query = buildEmbedQuery({ ...options, startTime });
	// Browsers only let a cross-origin iframe autoplay when the page delegates
	// it, so the attribute appears only when autoplay was asked for.
	const allow = options?.autoplay
		? `allow="autoplay; fullscreen; picture-in-picture"`
		: "";

	return `
	<div style="position: relative; padding-bottom: 56.25%; height: 0;">
			<iframe
			src="${webUrl}/embed/${videoId}${query}"
			frameborder="0"
			${allow}
			webkitallowfullscreen
			mozallowfullscreen
			allowfullscreen
			style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"
		></iframe>
	</div>
`
		.trim()
		.replace(/[\n\t]+/g, " ")
		.replace(/>\s+</g, "><")
		.replace(/"\s+>/g, '">');
};
