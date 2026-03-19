import { Option, Schema } from "effect";

export const ImageKey = Schema.String.pipe(Schema.brand("ImageKey"));
export type ImageKey = typeof ImageKey.Type;

export const ImageUrl = Schema.String.pipe(Schema.brand("ImageUrl"));
export type ImageUrl = typeof ImageUrl.Type;

export type ImageUrlOrKey = ImageUrl | ImageKey;

/**
 * Extracts an S3 file key from an image key or URL.
 * In some cases we can have image URLs from Google, so these need to be filtered out.
 */
export const extractFileKey = (
	iconKeyOrURL: ImageUrlOrKey,
	urlIsPathStyle: boolean,
): Option.Option<ImageKey> => {
	try {
		const { pathname, origin } = new URL(iconKeyOrURL);

		if (origin === "https://lh3.googleusercontent.com") return Option.none();

		let key = pathname.slice(1);

		if (urlIsPathStyle) {
			key = key.split("/").slice(1).join("/");
		}

		if (!key.trim()) return Option.none();

		return Option.some(ImageKey.make(key));
	} catch {
		return Option.some(ImageKey.make(iconKeyOrURL));
	}
};

export const ImageUpdatePayload = Schema.Option(
	Schema.Struct({
		data: Schema.Uint8ArrayFromBase64,
		contentType: Schema.String,
		fileName: Schema.String,
	}),
);
export type ImageUpdatePayload = typeof ImageUpdatePayload.Type;
