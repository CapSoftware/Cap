// Rich "Copy link" for Cap videos — writes text/html alongside the plain URL
// so pasting into Gmail/Outlook produces a branded, clickable thumbnail (the
// way Loom share links behave), while Slack/plain fields still get the URL.

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

export type RichVideoLink = {
	/** The share URL to copy (may include ?t= timestamp). */
	url: string;
	title: string;
	/**
	 * Absolute, publicly fetchable image URL (email proxies fetch it without
	 * cookies). The animated preview GIF with the OG card as fallback.
	 */
	previewImageUrl: string;
};

export const videoPreviewImageUrl = (webUrl: string, videoId: string) =>
	`${webUrl}/api/video/preview?videoId=${videoId}&fallback=og`;

export const richVideoLinkHtml = ({
	url,
	title,
	previewImageUrl,
}: RichVideoLink) => {
	const safeUrl = escapeHtml(url);
	const safeTitle = escapeHtml(title);
	const safeImage = escapeHtml(previewImageUrl);
	// Keep the markup minimal and inline-styled — email clients strip most
	// other things. The image links to the video, with a text link below.
	return (
		`<div>` +
		`<a href="${safeUrl}" title="${safeTitle}">` +
		`<img src="${safeImage}" alt="${safeTitle}" width="420" style="display:block;width:420px;max-width:100%;border-radius:10px;" />` +
		`</a>` +
		`<p style="margin:8px 0 0 0;">` +
		`<a href="${safeUrl}">${safeTitle}</a> — Watch on Cap` +
		`</p>` +
		`</div>`
	);
};

/**
 * Copies the link with a rich HTML representation when the browser allows it,
 * falling back to plain text. Must be called from a user gesture.
 */
export const copyRichVideoLink = async (link: RichVideoLink) => {
	try {
		if (
			typeof ClipboardItem !== "undefined" &&
			typeof navigator.clipboard?.write === "function"
		) {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/plain": new Blob([link.url], { type: "text/plain" }),
					"text/html": new Blob([richVideoLinkHtml(link)], {
						type: "text/html",
					}),
				}),
			]);
			return;
		}
	} catch {
		// Rich copy denied or unsupported — fall through to plain text.
	}
	await navigator.clipboard.writeText(link.url);
};
