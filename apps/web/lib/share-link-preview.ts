import type { VideoMetadata } from "@cap/database/types";

// Client safe on purpose: the dialog validates with the server's own rules.

export const LINK_PREVIEW_TITLE_MAX_LENGTH = 100;
/** Most unfurls show about this much of a title before cutting it off. */
export const LINK_PREVIEW_TITLE_SHOWN_LENGTH = 60;
export const LINK_PREVIEW_DESCRIPTION_MAX_LENGTH = 300;
export const LINK_PREVIEW_DESCRIPTION_SHOWN_LENGTH = 155;

export const LINK_PREVIEW_IMAGE_WIDTH = 1200;
export const LINK_PREVIEW_IMAGE_HEIGHT = 630;
export const LINK_PREVIEW_IMAGE_ASPECT =
	LINK_PREVIEW_IMAGE_WIDTH / LINK_PREVIEW_IMAGE_HEIGHT;
/** Under the 1 MB server action body limit, with room for the text fields. */
export const LINK_PREVIEW_IMAGE_MAX_BYTES = 900 * 1024;
export const LINK_PREVIEW_IMAGE_MIN_WIDTH = 600;
export const LINK_PREVIEW_IMAGE_MIN_HEIGHT = 315;
export const LINK_PREVIEW_IMAGE_MAX_WIDTH = 2400;
export const LINK_PREVIEW_IMAGE_MAX_HEIGHT = 1260;
const MIN_ASPECT = 1.7;
const MAX_ASPECT = 2.1;

export const DEFAULT_LINK_PREVIEW_DESCRIPTION = "Watch this video on Cap";

export const defaultLinkPreviewTitle = (videoName: string) =>
	`${videoName} | Cap Recording`;

export type StoredLinkPreview = NonNullable<VideoMetadata["linkPreview"]>;
export type StoredLinkPreviewImage = NonNullable<StoredLinkPreview["image"]>;
export type LinkPreviewImageType = StoredLinkPreviewImage["contentType"];

export type LinkPreviewState = {
	title: string | null;
	description: string | null;
	imageUrl: string | null;
};

export type LinkPreviewErrors = Partial<
	Record<"title" | "description" | "image", string>
>;

// C0/C1 controls (tabs and newlines become spaces below), soft hyphens,
// zero-width characters other than the joiner emoji need, and the bidi
// overrides that can make a title read differently than it is stored.
const isInvisible = (code: number) =>
	(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
	(code >= 0x7f && code <= 0x9f) ||
	code === 0xad ||
	code === 0x200b ||
	code === 0x200c ||
	code === 0x200e ||
	code === 0x200f ||
	(code >= 0x202a && code <= 0x202e) ||
	(code >= 0x2060 && code <= 0x2064) ||
	(code >= 0x2066 && code <= 0x2069) ||
	code === 0xfeff;

export function sanitizeLinkPreviewText(value: string): string {
	let visible = "";
	for (const character of value.normalize("NFC")) {
		if (!isInvisible(character.codePointAt(0) ?? 0)) visible += character;
	}
	return visible.replace(/\s+/g, " ").trim();
}

export type LinkPreviewTextInput = {
	title?: string | null;
	description?: string | null;
};

export type LinkPreviewTextValidation =
	| { ok: true; value: { title: string | null; description: string | null } }
	| { ok: false; errors: LinkPreviewErrors };

/** Blank fields mean "use the default", so they come back as null. */
export function validateLinkPreviewText(
	input: LinkPreviewTextInput,
): LinkPreviewTextValidation {
	const title = sanitizeLinkPreviewText(input.title ?? "");
	const description = sanitizeLinkPreviewText(input.description ?? "");
	const errors: LinkPreviewErrors = {};

	if (title.length > LINK_PREVIEW_TITLE_MAX_LENGTH) {
		errors.title = `Keep the title to ${LINK_PREVIEW_TITLE_MAX_LENGTH} characters or fewer`;
	}
	if (description.length > LINK_PREVIEW_DESCRIPTION_MAX_LENGTH) {
		errors.description = `Keep the description to ${LINK_PREVIEW_DESCRIPTION_MAX_LENGTH} characters or fewer`;
	}
	if (errors.title || errors.description) return { ok: false, errors };

	return {
		ok: true,
		value: { title: title || null, description: description || null },
	};
}

export type LinkPreviewImageInspection =
	| {
			ok: true;
			contentType: LinkPreviewImageType;
			width: number;
			height: number;
	  }
	| { ok: false; error: string };

const isPng = (bytes: Uint8Array) =>
	bytes.length >= 24 &&
	bytes[0] === 0x89 &&
	bytes[1] === 0x50 &&
	bytes[2] === 0x4e &&
	bytes[3] === 0x47 &&
	bytes[4] === 0x0d &&
	bytes[5] === 0x0a &&
	bytes[6] === 0x1a &&
	bytes[7] === 0x0a;

const isJpeg = (bytes: Uint8Array) =>
	bytes.length >= 4 &&
	bytes[0] === 0xff &&
	bytes[1] === 0xd8 &&
	bytes[2] === 0xff;

const readUint16 = (bytes: Uint8Array, offset: number) =>
	((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const readUint32 = (bytes: Uint8Array, offset: number) =>
	((bytes[offset] ?? 0) * 0x1000000 +
		(((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0))) >>>
	0;

const pngSize = (bytes: Uint8Array) => ({
	width: readUint32(bytes, 16),
	height: readUint32(bytes, 20),
});

const jpegSize = (bytes: Uint8Array) => {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1] ?? 0;
		if (marker === 0xff) {
			offset++;
			continue;
		}
		const isStartOfFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isStartOfFrame) {
			return {
				height: readUint16(bytes, offset + 5),
				width: readUint16(bytes, offset + 7),
			};
		}
		offset += 2 + readUint16(bytes, offset + 2);
	}
	return null;
};

// Judged from the bytes alone: the declared type, name and extension are
// all client controlled.
export function inspectLinkPreviewImage(
	bytes: Uint8Array,
): LinkPreviewImageInspection {
	if (bytes.length === 0) return { ok: false, error: "The image is empty" };
	if (bytes.length > LINK_PREVIEW_IMAGE_MAX_BYTES) {
		return { ok: false, error: "The image must be 900 KB or smaller" };
	}

	let contentType: LinkPreviewImageType;
	let size: { width: number; height: number } | null;
	if (isPng(bytes)) {
		contentType = "image/png";
		size = pngSize(bytes);
	} else if (isJpeg(bytes)) {
		contentType = "image/jpeg";
		size = jpegSize(bytes);
	} else {
		return { ok: false, error: "Use a JPEG or PNG image" };
	}

	if (!size || size.width <= 0 || size.height <= 0) {
		return { ok: false, error: "That image couldn't be read" };
	}
	if (
		size.width < LINK_PREVIEW_IMAGE_MIN_WIDTH ||
		size.height < LINK_PREVIEW_IMAGE_MIN_HEIGHT
	) {
		return {
			ok: false,
			error: `The image must be at least ${LINK_PREVIEW_IMAGE_MIN_WIDTH} × ${LINK_PREVIEW_IMAGE_MIN_HEIGHT}`,
		};
	}
	if (
		size.width > LINK_PREVIEW_IMAGE_MAX_WIDTH ||
		size.height > LINK_PREVIEW_IMAGE_MAX_HEIGHT
	) {
		return {
			ok: false,
			error: `The image must be ${LINK_PREVIEW_IMAGE_MAX_WIDTH} × ${LINK_PREVIEW_IMAGE_MAX_HEIGHT} or smaller`,
		};
	}
	const aspect = size.width / size.height;
	if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
		return {
			ok: false,
			error: `Crop the image to ${LINK_PREVIEW_IMAGE_WIDTH} × ${LINK_PREVIEW_IMAGE_HEIGHT}`,
		};
	}

	return { ok: true, contentType, width: size.width, height: size.height };
}

const linkPreviewImagePrefix = (videoId: string) => `link-previews/${videoId}/`;

export const linkPreviewImageKey = (
	videoId: string,
	contentType: LinkPreviewImageType,
	stamp: string,
) =>
	`${linkPreviewImagePrefix(videoId)}${stamp}.${contentType === "image/png" ? "png" : "jpg"}`;

/** Only ever delete objects this feature wrote for this video. */
export const isLinkPreviewImageKey = (videoId: string, key: string) =>
	key.startsWith(linkPreviewImagePrefix(videoId)) &&
	!key.slice(linkPreviewImagePrefix(videoId).length).includes("/");

/**
 * Who can see a video without signing in, reduced to a string. It goes into
 * the image URL's version so that making a video private, adding a password
 * or changing where it is shared moves the image to a URL no cache has seen.
 */
export type LinkPreviewAccess = {
	public: boolean;
	hasPassword: boolean;
	allowedEmailDomain: string | null;
	spaces: { id: string; hasPassword: boolean }[];
	organizationIds: string[];
};

export const linkPreviewAccessKey = (access: LinkPreviewAccess) =>
	JSON.stringify([
		access.public,
		access.hasPassword,
		access.allowedEmailDomain ?? "",
		access.spaces
			.map((space) => `${space.id}:${space.hasPassword ? 1 : 0}`)
			.sort(),
		[...access.organizationIds].sort(),
	]);

// FNV-1a: a cache buster, not a secret, and it has to run in the browser too.
const fnv1a = (value: string) => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
};

export const linkPreviewImageVersion = (key: string, accessKey?: string) => {
	const stamp = (key.split("/").pop() ?? "").replace(/\.[a-z]+$/, "");
	return accessKey === undefined ? stamp : `${stamp}-${fnv1a(accessKey)}`;
};

export const linkPreviewImagePath = (
	videoId: string,
	image: Pick<StoredLinkPreviewImage, "key">,
	accessKey?: string,
) =>
	`/api/video/link-preview?videoId=${encodeURIComponent(videoId)}&v=${encodeURIComponent(linkPreviewImageVersion(image.key, accessKey))}`;

// Shared caches keep the image for minutes, not hours: the version in the URL
// already moves when the video's access changes, and the short lifetime bounds
// how long an old URL can outlive a privacy change.
export const LINK_PREVIEW_CACHE_CONTROL = {
	current: "public, max-age=300, s-maxage=300, stale-while-revalidate=300",
	outdated: "public, max-age=60, s-maxage=60",
	signedIn: "private, max-age=300",
} as const;

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

export function readLinkPreview(
	metadata: unknown,
	videoId: string,
): StoredLinkPreview | null {
	if (!metadata || typeof metadata !== "object") return null;
	const raw = (metadata as { linkPreview?: unknown }).linkPreview;
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (value.version !== 1) return null;

	const title = isNonEmptyString(value.title)
		? sanitizeLinkPreviewText(value.title).slice(
				0,
				LINK_PREVIEW_TITLE_MAX_LENGTH,
			)
		: undefined;
	const description = isNonEmptyString(value.description)
		? sanitizeLinkPreviewText(value.description).slice(
				0,
				LINK_PREVIEW_DESCRIPTION_MAX_LENGTH,
			)
		: undefined;

	let image: StoredLinkPreviewImage | undefined;
	const rawImage = value.image as Record<string, unknown> | undefined;
	if (
		rawImage &&
		typeof rawImage === "object" &&
		isNonEmptyString(rawImage.key) &&
		isLinkPreviewImageKey(videoId, rawImage.key) &&
		isPositiveInteger(rawImage.width) &&
		isPositiveInteger(rawImage.height) &&
		isPositiveInteger(rawImage.size) &&
		(rawImage.contentType === "image/jpeg" ||
			rawImage.contentType === "image/png")
	) {
		image = {
			key: rawImage.key,
			width: rawImage.width,
			height: rawImage.height,
			contentType: rawImage.contentType,
			size: rawImage.size,
		};
	}

	if (!title && !description && !image) return null;
	return {
		version: 1,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(image ? { image } : {}),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
	};
}

export const toLinkPreviewState = (
	videoId: string,
	stored: StoredLinkPreview | null,
): LinkPreviewState | null =>
	stored
		? {
				title: stored.title ?? null,
				description: stored.description ?? null,
				imageUrl: stored.image
					? linkPreviewImagePath(videoId, stored.image)
					: null,
			}
		: null;

export function linkPreviewDisplayHost(
	customDomain: string | null | undefined,
	webUrl: string,
) {
	if (customDomain) return customDomain.toLowerCase();
	try {
		return new URL(webUrl).host.replace(/^www\./, "");
	} catch {
		return "cap.so";
	}
}
