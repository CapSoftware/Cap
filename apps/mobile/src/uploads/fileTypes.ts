const videoContentTypesByExtension: Record<string, string> = {
	avi: "video/x-msvideo",
	m4v: "video/x-m4v",
	mkv: "video/x-matroska",
	mov: "video/quicktime",
	mp4: "video/mp4",
	webm: "video/webm",
};

const extensionFromName = (name: string) => {
	const extension = name.split(".").at(-1)?.toLowerCase();
	return extension && extension !== name.toLowerCase() ? extension : null;
};

export const contentTypeFromName = (name: string) =>
	videoContentTypesByExtension[extensionFromName(name) ?? ""] ?? "video/mp4";

export const contentTypeForUpload = (
	name: string,
	contentType?: string | null,
) => {
	if (contentType?.startsWith("video/")) return contentType;
	return contentTypeFromName(name);
};
