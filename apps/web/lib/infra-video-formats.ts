export const INFRA_SUPPORTED_VIDEO_FORMATS =
	"MP4, MOV, MKV and WebM files with H.264, HEVC, VP8, VP9, AV1, ProRes, MPEG-4 or Motion JPEG video";

export const INFRA_UPLOAD_CONTENT_TYPES = [
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/x-matroska",
	"application/octet-stream",
] as const;

export const INFRA_REFUSED_CONTENT_TYPES = [
	"video/avi",
	"video/x-msvideo",
	"video/msvideo",
] as const;

export const INFRA_VIDEO_FILE_ACCEPT = [
	".mp4",
	".mov",
	".mkv",
	".webm",
	"video/mp4",
	"video/quicktime",
	"video/x-matroska",
	"video/webm",
].join(",");

const contentTypeEssence = (contentType: string) =>
	contentType.split(";")[0]?.trim().toLowerCase() ?? "";

export function isRefusedUploadContentType(contentType: string | undefined) {
	if (!contentType) return false;
	const essence = contentTypeEssence(contentType);
	return INFRA_REFUSED_CONTENT_TYPES.some((refused) => refused === essence);
}

// The farm gives this reason when a file is not a video. Refusing a type that
// is never a video at initiate gives the same answer before anything is stored.
// application/octet-stream and an empty type are not refused: browsers send
// those for real MKV and MOV files.
export const UNREADABLE_VIDEO_REASON = `This file could not be read as a video. Upload ${INFRA_SUPPORTED_VIDEO_FORMATS}.`;

const NON_VIDEO_CONTENT_TYPE =
	/^(text|image|audio)\/|^application\/(json|pdf)$/;

export function isNonVideoUploadContentType(contentType: string | undefined) {
	if (!contentType) return false;
	return NON_VIDEO_CONTENT_TYPE.test(contentTypeEssence(contentType));
}

export const UNSUPPORTED_CONTENT_TYPE_HINT = `Cap Infra accepts ${INFRA_SUPPORTED_VIDEO_FORMATS}. Send contentType as ${INFRA_UPLOAD_CONTENT_TYPES.join(", ")}.`;
