interface StrideCorrectionRequest {
	type: "correct-stride";
	buffer: ArrayBuffer;
	strideBytes: number;
	width: number;
	height: number;
	frameNumber: number;
}

interface StrideCorrectionResponse {
	type: "corrected";
	buffer: ArrayBuffer;
	width: number;
	height: number;
	frameNumber: number;
}

interface ErrorResponse {
	type: "error";
	message: string;
}

let correctionBuffer: Uint8ClampedArray | null = null;
let correctionBufferSize = 0;

self.onmessage = (e: MessageEvent<StrideCorrectionRequest>) => {
	if (e.data.type !== "correct-stride") return;

	try {
		const { buffer, strideBytes, width, height, frameNumber } = e.data;
		const expectedRowBytes = width * 4;
		const expectedLength = expectedRowBytes * height;

		if (width <= 0 || height <= 0 || strideBytes < expectedRowBytes) {
			const errorResponse: ErrorResponse = {
				type: "error",
				message: "Invalid stride correction dimensions",
			};
			self.postMessage(errorResponse);
			return;
		}

		const srcData = new Uint8ClampedArray(buffer);
		if (srcData.byteLength < strideBytes * height) {
			const errorResponse: ErrorResponse = {
				type: "error",
				message: "Stride correction buffer too small",
			};
			self.postMessage(errorResponse);
			return;
		}

		if (!correctionBuffer || correctionBufferSize < expectedLength) {
			correctionBuffer = new Uint8ClampedArray(expectedLength);
			correctionBufferSize = expectedLength;
		}

		for (let row = 0; row < height; row++) {
			const srcStart = row * strideBytes;
			const destStart = row * expectedRowBytes;
			correctionBuffer.set(
				srcData.subarray(srcStart, srcStart + expectedRowBytes),
				destStart,
			);
		}

		const result = correctionBuffer.slice(0, expectedLength);
		const response: StrideCorrectionResponse = {
			type: "corrected",
			buffer: result.buffer,
			width,
			height,
			frameNumber,
		};
		self.postMessage(response, { transfer: [result.buffer] });
	} catch (error) {
		const errorResponse: ErrorResponse = {
			type: "error",
			message:
				error instanceof Error ? error.message : "Stride correction failed",
		};
		self.postMessage(errorResponse);
	}
};

export type {
	StrideCorrectionRequest,
	StrideCorrectionResponse,
	ErrorResponse,
};
