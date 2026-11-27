/// A port of `image` 0.25's `DynamicImage::resize` with `FilterType::Triangle`,
/// which desktop and the render farm use to fit wallpapers within 2560 px.
/// Every step rounds to f32 in the crate's order, so the output is
/// byte-identical to the crate's for the same source pixels. The vertical and
/// horizontal passes run one output row at a time, which keeps the crate's
/// per-value arithmetic while holding one intermediate row instead of a whole
/// f32 image.

const f32 = Math.fround;

export function fitWithin(width: number, height: number, maxDimension: number) {
	const ratio = Math.min(maxDimension / width, maxDimension / height);
	return [
		Math.max(Math.round(width * ratio), 1),
		Math.max(Math.round(height * ratio), 1),
	] as const;
}

type Taps = {
	first: Int32Array;
	count: Int32Array;
	weights: Float32Array;
	stride: number;
};

function taps(inputSize: number, outputSize: number): Taps {
	const ratio = f32(inputSize / outputSize);
	const scale = ratio < 1 ? 1 : ratio;
	const stride = Math.ceil(scale) * 2 + 2;
	const first = new Int32Array(outputSize);
	const count = new Int32Array(outputSize);
	const weights = new Float32Array(outputSize * stride);
	for (let output = 0; output < outputSize; output++) {
		const center = f32(f32(output + 0.5) * ratio);
		const left = Math.min(
			Math.max(Math.floor(f32(center - scale)), 0),
			inputSize - 1,
		);
		const right = Math.min(
			Math.max(Math.ceil(f32(center + scale)), left + 1),
			inputSize,
		);
		const origin = f32(center - 0.5);
		const offset = output * stride;
		let sum = 0;
		for (let index = left; index < right; index++) {
			const distance = Math.abs(f32(f32(index - origin) / scale));
			const weight = distance < 1 ? f32(1 - distance) : 0;
			weights[offset + index - left] = weight;
			sum = f32(sum + weight);
		}
		for (let index = offset; index < offset + right - left; index++) {
			weights[index] = f32(weights[index] / sum);
		}
		first[output] = left;
		count[output] = right - left;
	}
	return { first, count, weights, stride };
}

export function isOpaque(pixels: Uint8Array | Uint8ClampedArray) {
	for (let index = 3; index < pixels.length; index += 4) {
		if (pixels[index] !== 255) return false;
	}
	return true;
}

/// The first tap of each sum is stored rather than added to zero, which the
/// crate's `0.0 + x` gives exactly, and opaque images skip the alpha channel,
/// whose sums are always 255.
export function resizeTriangle(
	pixels: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	outputWidth: number,
	outputHeight: number,
) {
	if (pixels.length !== width * height * 4) {
		throw new Error("Image pixels do not match their size");
	}
	const channels = isOpaque(pixels) ? 3 : 4;
	const vertical = taps(height, outputHeight);
	const horizontal = taps(width, outputWidth);
	const row = new Float32Array(width * channels);
	const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
	for (let y = 0; y < outputHeight; y++) {
		const top = vertical.first[y];
		const rows = vertical.count[y];
		const weightOffset = y * vertical.stride;
		for (let tap = 0; tap < rows; tap++) {
			const weight = vertical.weights[weightOffset + tap];
			let source = (top + tap) * width * 4;
			if (tap === 0) {
				for (let x = 0; x < row.length; x += channels, source += 4) {
					row[x] = f32(pixels[source] * weight);
					row[x + 1] = f32(pixels[source + 1] * weight);
					row[x + 2] = f32(pixels[source + 2] * weight);
					if (channels === 4) row[x + 3] = f32(pixels[source + 3] * weight);
				}
				continue;
			}
			for (let x = 0; x < row.length; x += channels, source += 4) {
				row[x] = f32(row[x] + f32(pixels[source] * weight));
				row[x + 1] = f32(row[x + 1] + f32(pixels[source + 1] * weight));
				row[x + 2] = f32(row[x + 2] + f32(pixels[source + 2] * weight));
				if (channels === 4) {
					row[x + 3] = f32(row[x + 3] + f32(pixels[source + 3] * weight));
				}
			}
		}
		let target = y * outputWidth * 4;
		for (let x = 0; x < outputWidth; x++, target += 4) {
			const columns = horizontal.count[x];
			let weightIndex = x * horizontal.stride;
			let source = horizontal.first[x] * channels;
			let weight = horizontal.weights[weightIndex];
			let red = f32(row[source] * weight);
			let green = f32(row[source + 1] * weight);
			let blue = f32(row[source + 2] * weight);
			let alpha = channels === 4 ? f32(row[source + 3] * weight) : 255;
			for (let tap = 1; tap < columns; tap++) {
				source += channels;
				weight = horizontal.weights[++weightIndex];
				red = f32(red + f32(row[source] * weight));
				green = f32(green + f32(row[source + 1] * weight));
				blue = f32(blue + f32(row[source + 2] * weight));
				if (channels === 4) {
					alpha = f32(alpha + f32(row[source + 3] * weight));
				}
			}
			output[target] = Math.round(red);
			output[target + 1] = Math.round(green);
			output[target + 2] = Math.round(blue);
			output[target + 3] = Math.round(alpha);
		}
	}
	return output;
}
