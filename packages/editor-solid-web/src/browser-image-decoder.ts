type DecodeResponse =
	| { id: number; ok: true; width: number; height: number; pixels: ArrayBuffer }
	| { id: number; ok: false; error: string };

export type DecodedBackgroundImage = {
	width: number;
	height: number;
	pixels: ArrayBuffer;
};

export class BrowserImageDecoder {
	private worker: Worker | null = null;
	private readonly pending = new Map<
		number,
		{
			resolve: (image: DecodedBackgroundImage) => void;
			reject: (error: Error) => void;
		}
	>();
	private nextId = 1;
	private disposed = false;

	private fail(error: Error) {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		this.worker?.terminate();
		this.worker = null;
	}

	private createWorker() {
		const worker = new Worker(
			new URL("./browser-image-decoder-worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.addEventListener(
			"message",
			(event: MessageEvent<DecodeResponse>) => {
				const result = event.data;
				const request = this.pending.get(result.id);
				if (!request) return;
				this.pending.delete(result.id);
				if (!result.ok) {
					request.reject(new Error(result.error));
					return;
				}
				if (
					!Number.isSafeInteger(result.width) ||
					!Number.isSafeInteger(result.height) ||
					result.width < 1 ||
					result.height < 1 ||
					result.width * result.height > 16_777_216 ||
					result.pixels.byteLength !== result.width * result.height * 4
				) {
					request.reject(new Error("Editor image pixels are invalid"));
					return;
				}
				request.resolve(result);
			},
		);
		worker.addEventListener("error", () => {
			this.fail(new Error("Editor image decoder failed"));
		});
		worker.addEventListener("messageerror", () => {
			this.fail(new Error("Editor image decoder response failed"));
		});
		this.worker = worker;
		return worker;
	}

	async decode(bytes: ArrayBuffer): Promise<DecodedBackgroundImage> {
		if (this.disposed) throw new Error("Editor image decoder is closed");
		if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
			throw new Error("Editor background image is invalid");
		}
		if (typeof Worker === "undefined") {
			const module = await import(
				"../image-decoder/pkg/cap_editor_image_decoder.js"
			);
			await module.default();
			const image = module.decode_image(new Uint8Array(bytes), 2560);
			const width = image.width();
			const height = image.height();
			return { width, height, pixels: image.pixels().buffer as ArrayBuffer };
		}
		const worker = this.worker ?? this.createWorker();
		const id = this.nextId++;
		return new Promise<DecodedBackgroundImage>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				worker.postMessage({ id, bytes, maxDimension: 2560 }, [bytes]);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.fail(new Error("Editor image decoder is closed"));
	}
}
