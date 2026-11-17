const DOWNLOAD_FRAME_LIFETIME_MS = 5 * 60 * 1000;

// The URL is signed with `Content-Disposition: attachment`, so the browser
// streams the file to disk itself. Fetching it into a Blob first lost large
// recordings: Chrome cancels the save of an ArrayBuffer-backed Blob past
// roughly 500 MiB after the success toast, and rejects `response.blob()` past
// 2 GiB. A hidden frame is used instead of a link click because Chrome fires
// `beforeunload` for the click, which prompts "Leave site?" mid-upload. Each
// download gets its own frame: removing one before its response headers
// arrive cancels that download, and an attachment never fires `load`.
export function startBrowserDownload(url: string) {
	const frame = document.createElement("iframe");
	frame.hidden = true;
	frame.src = url;
	document.body.appendChild(frame);
	window.setTimeout(() => frame.remove(), DOWNLOAD_FRAME_LIFETIME_MS);
}
