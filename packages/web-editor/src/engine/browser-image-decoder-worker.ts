import { MISSING_EDITOR_IMAGE } from "./editor-image-missing";
import { readImageHeader } from "./image-header";
import { fitWithin, isOpaque, resizeTriangle } from "./triangle-resize";

type DecodeRequest = {
	id: number;
	maxDimension: number;
	kind: "background" | "overlay";
} & ({ bytes: ArrayBuffer } | { url: string });

type DecodeLevel = {
	width: number;
	height: number;
	pixels: ArrayBuffer;
};

type DecodeResponse =
	| {
			id: number;
			ok: true;
			kind: "background";
			width: number;
			height: number;
			pixels: ArrayBuffer;
	  }
	| { id: number; ok: true; kind: "overlay"; levels: DecodeLevel[] }
	| { id: number; ok: false; error: string };

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (event: MessageEvent<DecodeRequest>) => void,
	) => void;
	postMessage: (message: DecodeResponse, transfer?: Transferable[]) => void;
};

let decoder: Promise<
	typeof import("../../image-decoder/pkg/cap_editor_image_decoder.js")
> | null = null;

function loadDecoder() {
	if (!decoder) {
		decoder = import("../../image-decoder/pkg/cap_editor_image_decoder.js")
			.then(async (module) => {
				await module.default();
				return module;
			})
			.catch((error: unknown) => {
				decoder = null;
				throw error;
			});
	}
	return decoder;
}

/// The browser's own JPEG/PNG decoder is several times faster than the wasm
/// one for large wallpapers, and the wasm one runs for seconds in some
/// Firefox builds. Pixels come back unconverted and straight alpha, like the
/// wasm decoder's, and larger opaque images are fitted with native's own
/// Triangle filter. Two kinds stay on the wasm decoder: larger images with
/// transparency, whose colours a 2D canvas rounds by premultiplying, and
/// images with an EXIF rotation, which the browser applies to JPEGs whatever
/// `imageOrientation` says while native draws the stored pixels.
async function decodeNatively(bytes: ArrayBuffer, maxDimension: number) {
	if (
		typeof createImageBitmap !== "function" ||
		typeof OffscreenCanvas === "undefined"
	) {
		return null;
	}
	const header = readImageHeader(
		new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024 * 1024)),
	);
	if (
		header &&
		(header.orientation !== 1 ||
			header.width * header.height > 16_777_216 ||
			Math.max(header.width, header.height) > 8192)
	) {
		return null;
	}
	try {
		const bitmap = await createImageBitmap(new Blob([bytes]), {
			colorSpaceConversion: "none",
			premultiplyAlpha: "none",
		});
		const { width, height } = bitmap;
		if (width * height > 16_777_216 || Math.max(width, height) > 8192) {
			bitmap.close();
			return null;
		}
		const context = new OffscreenCanvas(width, height).getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) {
			bitmap.close();
			return null;
		}
		context.drawImage(bitmap, 0, 0);
		bitmap.close();
		const pixels = context.getImageData(0, 0, width, height).data;
		if (Math.max(width, height) <= maxDimension) {
			return { width, height, pixels: pixels.buffer };
		}
		if (!isOpaque(pixels)) return null;
		const [fitWidth, fitHeight] = fitWithin(width, height, maxDimension);
		return {
			width: fitWidth,
			height: fitHeight,
			pixels: resizeTriangle(pixels, width, height, fitWidth, fitHeight).buffer,
		};
	} catch {
		return null;
	}
}

async function requestBytes(request: DecodeRequest) {
	if ("bytes" in request) return request.bytes;
	const response = await fetch(request.url, {
		cache: "default",
		credentials: "same-origin",
	});
	if (response.status === 410) throw new Error(MISSING_EDITOR_IMAGE);
	if (!response.ok) throw new Error("Editor image could not load");
	const bytes = await response.arrayBuffer();
	if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
		throw new Error("Editor image is invalid");
	}
	return bytes;
}

scope.addEventListener("message", (event) => {
	const { id, maxDimension, kind } = event.data;
	void requestBytes(event.data).then(
		async (bytes) => {
			if (kind === "background") {
				const image = await decodeNatively(bytes, maxDimension);
				if (image) {
					scope.postMessage({ id, ok: true, kind, ...image }, [image.pixels]);
					return;
				}
			}
			decodeWithWasm(id, bytes, maxDimension, kind);
		},
		(error: unknown) => {
			scope.postMessage({
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		},
	);
});

function decodeWithWasm(
	id: number,
	bytes: ArrayBuffer,
	maxDimension: number,
	kind: DecodeRequest["kind"],
) {
	void loadDecoder()
		.then((module) => {
			if (kind === "overlay") {
				const image = module.decode_overlay_image(
					new Uint8Array(bytes),
					maxDimension,
				);
				try {
					const levels: DecodeLevel[] = [];
					const transfer: Transferable[] = [];
					for (let index = 0; index < image.level_count(); index++) {
						const pixels = image.take_level_pixels(index);
						if (!(pixels.buffer instanceof ArrayBuffer)) {
							throw new Error("Editor overlay image pixels are unavailable");
						}
						levels.push({
							width: image.level_width(index),
							height: image.level_height(index),
							pixels: pixels.buffer,
						});
						transfer.push(pixels.buffer);
					}
					scope.postMessage({ id, ok: true, kind, levels }, transfer);
				} finally {
					image.free();
				}
				return;
			}
			const image = module.decode_image(new Uint8Array(bytes), maxDimension);
			const width = image.width();
			const height = image.height();
			const pixels = image.pixels();
			if (!(pixels.buffer instanceof ArrayBuffer)) {
				throw new Error("Editor image pixels are unavailable");
			}
			scope.postMessage(
				{
					id,
					ok: true,
					kind: "background",
					width,
					height,
					pixels: pixels.buffer,
				},
				[pixels.buffer],
			);
		})
		.catch((error: unknown) => {
			scope.postMessage({
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
}
