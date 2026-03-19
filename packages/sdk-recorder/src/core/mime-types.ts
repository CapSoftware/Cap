const PREFERRED_MIME_TYPES = [
	"video/webm;codecs=vp9,opus",
	"video/webm;codecs=vp8,opus",
	"video/webm;codecs=vp9",
	"video/webm;codecs=vp8",
	"video/webm",
	"video/mp4",
];

export function getSupportedMimeType(): string {
	for (const mimeType of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return mimeType;
		}
	}
	return "";
}
