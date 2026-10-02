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

type DecodeSuccess = Extract<DecodeResponse, { ok: true }>;

export type DecodedBackgroundImage = {
	width: number;
	height: number;
	pixels: ArrayBuffer;
};

export type DecodedOverlayImage = {
	levels: DecodeLevel[];
};

export class BrowserImageDecoder {
	private worker: Worker | null = null;
	private readonly pending = new Map<
		number,
		{
			kind: "background" | "overlay";
			resolve: (image: DecodeSuccess) => void;
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
				if (result.kind !== request.kind) {
					request.reject(new Error("Editor image decoder response is invalid"));
					return;
				}
				if (result.kind === "background") {
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
				} else {
					if (result.levels.length < 1 || result.levels.length > 16) {
						request.reject(new Error("Editor overlay mip levels are invalid"));
						return;
					}
					let bytes = 0;
					let width = result.levels[0]?.width ?? 0;
					let height = result.levels[0]?.height ?? 0;
					for (const level of result.levels) {
						if (
							!Number.isSafeInteger(level.width) ||
							!Number.isSafeInteger(level.height) ||
							level.width !== width ||
							level.height !== height ||
							level.width < 1 ||
							level.height < 1 ||
							level.width * level.height > 16_777_216 ||
							level.pixels.byteLength !== level.width * level.height * 4
						) {
							request.reject(
								new Error("Editor overlay mip pixels are invalid"),
							);
							return;
						}
						bytes += level.pixels.byteLength;
						width = Math.max(1, Math.floor(width / 2));
						height = Math.max(1, Math.floor(height / 2));
					}
					if (bytes > 96 * 1024 * 1024) {
						request.reject(
							new Error("Editor overlay image exceeds memory limit"),
						);
						return;
					}
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

	private request(
		bytes: ArrayBuffer,
		kind: "background" | "overlay",
		maxDimension: number,
	): Promise<DecodeSuccess> {
		const worker = this.worker ?? this.createWorker();
		const id = this.nextId++;
		return new Promise<DecodeSuccess>((resolve, reject) => {
			this.pending.set(id, { kind, resolve, reject });
			try {
				worker.postMessage({ id, bytes, maxDimension, kind }, [bytes]);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
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
			return {
				width: image.width(),
				height: image.height(),
				pixels: image.pixels().buffer as ArrayBuffer,
			};
		}
		const result = await this.request(bytes, "background", 2560);
		if (result.kind !== "background") {
			throw new Error("Editor background image response is invalid");
		}
		return {
			width: result.width,
			height: result.height,
			pixels: result.pixels,
		};
	}

	async decodeOverlay(
		bytes: ArrayBuffer,
		maxDimension: number,
	): Promise<DecodedOverlayImage> {
		if (this.disposed) throw new Error("Editor image decoder is closed");
		if (
			bytes.byteLength < 1 ||
			bytes.byteLength > 64 * 1024 * 1024 ||
			!Number.isSafeInteger(maxDimension) ||
			maxDimension < 1 ||
			maxDimension > 4096
		) {
			throw new Error("Editor overlay image is invalid");
		}
		if (typeof Worker === "undefined") {
			const module = await import(
				"../image-decoder/pkg/cap_editor_image_decoder.js"
			);
			await module.default();
			const image = module.decode_overlay_image(
				new Uint8Array(bytes),
				maxDimension,
			);
			try {
				const levels: DecodeLevel[] = [];
				for (let index = 0; index < image.level_count(); index++) {
					const pixels = image.take_level_pixels(index);
					levels.push({
						width: image.level_width(index),
						height: image.level_height(index),
						pixels: pixels.buffer as ArrayBuffer,
					});
				}
				return { levels };
			} finally {
				image.free();
			}
		}
		const result = await this.request(bytes, "overlay", maxDimension);
		if (result.kind !== "overlay") {
			throw new Error("Editor overlay image response is invalid");
		}
		return { levels: result.levels };
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.fail(new Error("Editor image decoder is closed"));
	}
}
