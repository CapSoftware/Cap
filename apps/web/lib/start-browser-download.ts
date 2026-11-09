// Hand the signed URL to the browser instead of fetching it into a Blob. The
// URL is signed with `Content-Disposition: attachment`, so the browser streams
// the file straight to disk with its own progress and resume. Buffering it in
// a Blob first failed for recordings over 2 GiB in Chrome and held the whole
// file in memory everywhere else.
export function startBrowserDownload(url: string, fileName: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.rel = "noopener";
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	link.remove();
}
