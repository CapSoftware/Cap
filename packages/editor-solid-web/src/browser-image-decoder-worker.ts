type DecodeRequest = {
	id: number;
	bytes: ArrayBuffer;
	maxDimension: number;
	kind: "background" | "overlay";
};

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
	typeof import("../image-decoder/pkg/cap_editor_image_decoder.js")
> | null = null;

function loadDecoder() {
	if (!decoder) {
		decoder = import("../image-decoder/pkg/cap_editor_image_decoder.js")
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
/// one for large wallpapers. Pixels come back unconverted and straight alpha,
/// like the wasm decoder's, so both paths render the same.
async function decodeNatively(bytes: ArrayBuffer, maxDimension: number) {
	if (
		typeof createImageBitmap !== "function" ||
		typeof OffscreenCanvas === "undefined"
	) {
		return null;
	}
	try {
		const bitmap = await createImageBitmap(new Blob([bytes]), {
			colorSpaceConversion: "none",
			premultiplyAlpha: "none",
		});
		const scale = Math.min(
			1,
			maxDimension / Math.max(bitmap.width, bitmap.height),
		);
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const context = new OffscreenCanvas(width, height).getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) return null;
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		const pixels = context.getImageData(0, 0, width, height).data.buffer;
		return { width, height, pixels };
	} catch {
		return null;
	}
}

scope.addEventListener("message", (event) => {
	const { id, bytes, maxDimension, kind } = event.data;
	if (kind === "background") {
		void decodeNatively(bytes, maxDimension).then((image) => {
			if (image) {
				scope.postMessage({ id, ok: true, kind, ...image }, [image.pixels]);
			} else {
				decodeWithWasm(id, bytes, maxDimension, kind);
			}
		});
		return;
	}
	decodeWithWasm(id, bytes, maxDimension, kind);
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
