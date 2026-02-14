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

	const { buffer, strideBytes, width, height, frameNumber } = e.data;
	const expectedRowBytes = width * 4;
	const expectedLength = expectedRowBytes * height;

	if (!correctionBuffer || correctionBufferSize < expectedLength) {
		correctionBuffer = new Uint8ClampedArray(expectedLength);
		correctionBufferSize = expectedLength;
	}

	const srcData = new Uint8ClampedArray(buffer);
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
};

export type {
	StrideCorrectionRequest,
	StrideCorrectionResponse,
	ErrorResponse,
};
