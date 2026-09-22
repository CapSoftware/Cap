type DecodeRequest = {
	id: number;
	bytes: ArrayBuffer;
	maxDimension: number;
};

type DecodeResponse =
	| { id: number; ok: true; width: number; height: number; pixels: ArrayBuffer }
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

scope.addEventListener("message", (event) => {
	const { id, bytes, maxDimension } = event.data;
	void loadDecoder()
		.then((module) => {
			const image = module.decode_image(new Uint8Array(bytes), maxDimension);
			const width = image.width();
			const height = image.height();
			const pixels = image.pixels();
			if (!(pixels.buffer instanceof ArrayBuffer)) {
				throw new Error("Editor image pixels are unavailable");
			}
			scope.postMessage(
				{ id, ok: true, width, height, pixels: pixels.buffer },
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
});
