import type { ImageSegment, XY } from "~/utils/tauri";

export type { ImageSegment } from "~/utils/tauri";
export type ImageAsset = {
	path: string;
	name: string;
	width: number;
	height: number;
};

export function fitImageSize(
	width: number,
	height: number,
	outputWidth: number,
	outputHeight: number,
): XY<number> {
	if (
		![width, height, outputWidth, outputHeight].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	)
		return { x: 0.3, y: 0.3 };
	const scale = Math.min(
		(outputWidth * 0.3) / width,
		(outputHeight * 0.3) / height,
	);
	return {
		x: (width * scale) / outputWidth,
		y: (height * scale) / outputHeight,
	};
}

export function defaultImageSegment(
	asset: ImageAsset,
	start: number,
	end: number,
	track: number,
	output: { width: number; height: number },
): ImageSegment {
	return {
		start,
		end,
		track,
		enabled: true,
		path: asset.path,
		name: asset.name,
		center: { x: 0.5, y: 0.5 },
		size: fitImageSize(asset.width, asset.height, output.width, output.height),
		opacity: 1,
		rotation: 0,
		rounding: 0,
		flipX: false,
		flipY: false,
		lockAspect: true,
	};
}

export function imageAssetPath(projectPath: string, relative: string) {
	if (!/^content\/images\/[^/\\]+$/.test(relative) || relative.includes(".."))
		return null;
	return `${projectPath.replace(/[\\/]$/, "")}/${relative}`;
}

export function resizeImage(
	segment: Pick<ImageSegment, "center" | "size" | "rotation" | "lockAspect">,
	delta: XY<number>,
	corner: XY<number>,
	canvas: { width: number; height: number },
) {
	const radians = (segment.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const localX = delta.x * cos + delta.y * sin;
	const localY = -delta.x * sin + delta.y * cos;
	const width = segment.size.x * canvas.width;
	const height = segment.size.y * canvas.height;
	let nextWidth = Math.max(8, width + corner.x * localX);
	let nextHeight = Math.max(8, height + corner.y * localY);
	if (segment.lockAspect) {
		const scale = Math.max(
			8 / Math.max(1, Math.min(width, height)),
			(nextWidth * width + nextHeight * height) /
				Math.max(1, width * width + height * height),
		);
		nextWidth = width * scale;
		nextHeight = height * scale;
	}
	const offsetX = (corner.x * (nextWidth - width)) / 2;
	const offsetY = (corner.y * (nextHeight - height)) / 2;
	return {
		center: {
			x: segment.center.x + (offsetX * cos - offsetY * sin) / canvas.width,
			y: segment.center.y + (offsetX * sin + offsetY * cos) / canvas.height,
		},
		size: { x: nextWidth / canvas.width, y: nextHeight / canvas.height },
	};
}

export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_IMAGE_DIMENSION = 32_768;

type ImageDimensions = { width: number; height: number };

export function validateImageDimensions(dimensions: ImageDimensions) {
	const { width, height } = dimensions;
	if (
		![width, height].every(
			(value) =>
				Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION,
		) ||
		width * height > MAX_IMAGE_PIXELS
	) {
		throw new Error(
			"Images must be at most 16 megapixels (16,777,216 pixels) and 32,768 pixels per side.",
		);
	}
	return dimensions;
}

export function inspectImageDimensions(bytes: Uint8Array): ImageDimensions {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, value: string) =>
		[...value].every(
			(character, index) => bytes[offset + index] === character.charCodeAt(0),
		);
	let dimensions: ImageDimensions | undefined;
	if (
		bytes.length >= 24 &&
		bytes[0] === 137 &&
		ascii(1, "PNG\r\n\x1a\n") &&
		ascii(12, "IHDR")
	) {
		dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
	} else if (bytes.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) {
		dimensions = {
			width: view.getUint16(6, true),
			height: view.getUint16(8, true),
		};
	} else if (
		bytes.length >= 26 &&
		ascii(0, "BM") &&
		view.getUint32(14, true) >= 40
	) {
		dimensions = {
			width: view.getInt32(18, true),
			height: Math.abs(view.getInt32(22, true)),
		};
	} else if (bytes.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
		if (ascii(12, "VP8X")) {
			const uint24 = (offset: number) =>
				bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
			dimensions = { width: uint24(24) + 1, height: uint24(27) + 1 };
		} else if (ascii(12, "VP8L") && bytes[20] === 47) {
			dimensions = {
				width: 1 + (bytes[21] | ((bytes[22] & 63) << 8)),
				height:
					1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10)),
			};
		} else if (
			ascii(12, "VP8 ") &&
			bytes[23] === 157 &&
			bytes[24] === 1 &&
			bytes[25] === 42
		) {
			dimensions = {
				width: view.getUint16(26, true) & 16383,
				height: view.getUint16(28, true) & 16383,
			};
		}
	} else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 255) break;
			while (bytes[offset + 1] === 255) offset++;
			const marker = bytes[offset + 1];
			if (marker === 217 || marker === 218) break;
			if (marker === 1 || (marker >= 208 && marker <= 215)) {
				offset += 2;
				continue;
			}
			if (offset + 4 > bytes.length) break;
			const length = view.getUint16(offset + 2);
			if (length < 2 || offset + 2 + length > bytes.length) break;
			if (
				[
					192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
				].includes(marker) &&
				length >= 7
			) {
				dimensions = {
					width: view.getUint16(offset + 7),
					height: view.getUint16(offset + 5),
				};
				break;
			}
			offset += length + 2;
		}
	}
	if (!dimensions)
		throw new Error(
			"This image format is unsupported or the file is damaged. Choose a PNG, JPEG, WebP, GIF or BMP image.",
		);
	return validateImageDimensions(dimensions);
}

type ImageImportIO = {
	read(path: string): Promise<Uint8Array>;
	decode(bytes: Uint8Array): Promise<ImageDimensions>;
	mkdir(path: string): Promise<void>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	id(): string;
};

type ImageFile = {
	stat(): Promise<{ size: number; isFile: boolean }>;
	read(buffer: Uint8Array): Promise<number | null>;
	close(): Promise<void>;
};

export async function readBoundedImage(file: ImageFile) {
	try {
		const info = await file.stat();
		if (
			!info.isFile ||
			!Number.isSafeInteger(info.size) ||
			info.size <= 0 ||
			info.size > MAX_IMAGE_FILE_BYTES
		)
			throw new Error("Choose a non-empty image no larger than 64 MiB.");
		const bytes = new Uint8Array(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await file.read(
				bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024)),
			);
			if (!read)
				throw new Error(
					"The image changed while importing. Please choose the file again.",
				);
			offset += read;
		}
		if (await file.read(new Uint8Array(1)))
			throw new Error(
				"The image changed while importing. Please choose the file again.",
			);
		return bytes;
	} finally {
		await file.close();
	}
}

export async function importImagePath(
	projectPath: string,
	source: string,
	io: ImageImportIO,
): Promise<ImageAsset> {
	const name = source.split(/[\\/]/).pop() ?? "Image";
	const extension = name.split(".").pop()?.toLowerCase();
	if (
		!extension ||
		!["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)
	)
		throw new Error("Choose a PNG, JPEG, WebP, GIF or BMP image.");
	const bytes = await io.read(source);
	if (!bytes.length || bytes.length > MAX_IMAGE_FILE_BYTES)
		throw new Error("Choose a non-empty image no larger than 64 MiB.");
	const encodedDimensions = inspectImageDimensions(bytes);
	let dimensions: ImageDimensions;
	try {
		dimensions = validateImageDimensions(await io.decode(bytes));
	} catch {
		throw new Error(
			"This image could not be decoded. Choose a valid PNG, JPEG, WebP, GIF or BMP image.",
		);
	}
	if (
		dimensions.width * dimensions.height !==
		encodedDimensions.width * encodedDimensions.height
	)
		throw new Error(
			"This image has inconsistent dimensions and cannot be imported.",
		);
	const path = `content/images/${io.id()}.${extension}`;
	const destination = imageAssetPath(projectPath, path);
	if (!destination || destination === source)
		throw new Error("Unable to create an image asset path.");
	await io.mkdir(`${projectPath}/content/images`);
	await io.write(destination, bytes);
	return { path, name, ...dimensions };
}

export async function pickImage(
	projectPath: string,
): Promise<ImageAsset | null> {
	const [{ open }, fs] = await Promise.all([
		import("@tauri-apps/plugin-dialog"),
		import("@tauri-apps/plugin-fs"),
	]);
	const source = await open({
		multiple: false,
		directory: false,
		filters: [
			{
				name: "Images",
				extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
			},
		],
	});
	if (typeof source !== "string") return null;
	return importImagePath(projectPath, source, {
		read: async (path) => readBoundedImage(await fs.open(path, { read: true })),
		mkdir: (path) => fs.mkdir(path, { recursive: true }),
		write: async (path, bytes) => {
			const file = await fs.open(path, { write: true, createNew: true });
			try {
				let offset = 0;
				while (offset < bytes.length) {
					const written = await file.write(
						bytes.subarray(
							offset,
							Math.min(bytes.length, offset + 1024 * 1024),
						),
					);
					if (!written)
						throw new Error("Unable to save the image in this project.");
					offset += written;
				}
			} finally {
				await file.close();
			}
		},
		id: () => crypto.randomUUID(),
		decode: async (bytes) => {
			const bitmap = await createImageBitmap(
				new Blob([new Uint8Array(bytes)]),
				{ imageOrientation: "from-image" },
			);
			try {
				return { width: bitmap.width, height: bitmap.height };
			} finally {
				bitmap.close();
			}
		},
	});
}
