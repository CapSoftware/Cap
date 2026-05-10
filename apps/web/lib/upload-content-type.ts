export function contentTypeForSubpath(subpath: string): string {
	if (subpath.endsWith(".json")) return "application/json";
	if (subpath.endsWith(".mp4") || subpath.endsWith(".m4s")) return "video/mp4";
	if (subpath.endsWith(".jpg") || subpath.endsWith(".jpeg"))
		return "image/jpeg";
	if (subpath.endsWith(".m4a")) return "audio/mp4";
	if (subpath.endsWith(".aac")) return "audio/aac";
	if (subpath.endsWith(".webm")) return "video/webm";
	if (subpath.endsWith(".m3u8")) return "application/x-mpegURL";
	return "application/octet-stream";
}
