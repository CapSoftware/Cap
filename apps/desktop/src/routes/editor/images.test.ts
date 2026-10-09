import { describe, expect, it, vi } from "vitest";
import {
	defaultImageSegment,
	fitImageSize,
	imageAssetPath,
	importImagePath,
	inspectImageDimensions,
	MAX_IMAGE_FILE_BYTES,
	readBoundedImage,
	resizeImage,
	validateImageDimensions,
} from "./images";

function png(width: number, height: number) {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
	bytes.set([73, 72, 68, 82], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function importIO(bytes = png(600, 400)) {
	return {
		read: vi.fn(async () => bytes),
		decode: vi.fn(async () => ({ width: 600, height: 400 })),
		mkdir: vi.fn(async () => {}),
		write: vi.fn(async () => {}),
		id: () => "unique",
	};
}

describe("image import", () => {
	it("copies a source into the project with a relative path and oriented dimensions", async () => {
		const io = importIO();
		io.decode.mockResolvedValue({ width: 400, height: 600 });
		const image = await importImagePath(
			"/project.cap",
			"/original/photo.png",
			io,
		);
		expect(image).toEqual({
			path: "content/images/unique.png",
			name: "photo.png",
			width: 400,
			height: 600,
		});
		expect(io.mkdir).toHaveBeenCalledWith("/project.cap/content/images");
		expect(io.write).toHaveBeenCalledWith(
			"/project.cap/content/images/unique.png",
			png(600, 400),
		);
		expect(io.write).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized dimensions before allocating a decoded image or copying", async () => {
		const io = importIO(png(20_000, 20_000));
		await expect(
			importImagePath("/project.cap", "/original/large.png", io),
		).rejects.toThrow("16 megapixels");
		expect(io.decode).not.toHaveBeenCalled();
		expect(io.write).not.toHaveBeenCalled();
	});

	it("rejects unsupported or corrupt bytes and allows retrying the same source", async () => {
		const io = importIO(new Uint8Array([1, 2, 3]));
		await expect(
			importImagePath("/project.cap", "/original/photo.png", io),
		).rejects.toThrow("unsupported");
		expect(io.write).not.toHaveBeenCalled();
		io.read.mockResolvedValue(png(600, 400));
		await expect(
			importImagePath("/project.cap", "/original/photo.png", io),
		).resolves.toMatchObject({ path: "content/images/unique.png" });
	});

	it("does not copy files that the browser cannot decode", async () => {
		const io = importIO();
		io.decode.mockRejectedValue(new Error("bad data"));
		await expect(
			importImagePath("/project.cap", "/original/photo.png", io),
		).rejects.toThrow("could not be decoded");
		expect(io.write).not.toHaveBeenCalled();
	});

	it("propagates destination errors without returning an insertable asset", async () => {
		const io = importIO();
		io.write.mockRejectedValue(new Error("disk full"));
		await expect(
			importImagePath("/project.cap", "/original/photo.png", io),
		).rejects.toThrow("disk full");
	});

	it("rejects file size before reading and always closes its handle", async () => {
		const file = {
			stat: vi.fn(async () => ({
				size: MAX_IMAGE_FILE_BYTES + 1,
				isFile: true,
			})),
			read: vi.fn(async () => null),
			close: vi.fn(async () => {}),
		};
		await expect(readBoundedImage(file)).rejects.toThrow("64 MiB");
		expect(file.read).not.toHaveBeenCalled();
		expect(file.close).toHaveBeenCalledTimes(1);
	});

	it("handles partial reads and rejects source growth", async () => {
		let position = 0;
		const file = {
			stat: async () => ({ size: 4, isFile: true }),
			read: vi.fn(async (buffer: Uint8Array) => {
				const count = Math.min(2, buffer.length, 4 - position);
				buffer.fill(7, 0, count);
				position += count;
				return count || null;
			}),
			close: vi.fn(async () => {}),
		};
		expect(await readBoundedImage(file)).toEqual(new Uint8Array([7, 7, 7, 7]));
		expect(file.close).toHaveBeenCalledTimes(1);
		file.read.mockImplementation(async (buffer) => buffer.length);
		await expect(readBoundedImage(file)).rejects.toThrow(
			"changed while importing",
		);
		expect(file.close).toHaveBeenCalledTimes(2);
	});

	it("reads JPEG dimensions ahead of decode, including files with metadata", () => {
		const jpeg = new Uint8Array([
			255, 216, 255, 225, 0, 4, 0, 0, 255, 192, 0, 11, 8, 1, 144, 2, 88, 1, 1,
			17, 0, 255, 217,
		]);
		expect(inspectImageDimensions(jpeg)).toEqual({ width: 600, height: 400 });
		expect(inspectImageDimensions(png(4096, 4096))).toEqual({
			width: 4096,
			height: 4096,
		});
		expect(() =>
			validateImageDimensions({ width: 32769, height: 1 }),
		).toThrow();
		expect(() => validateImageDimensions({ width: 0, height: 1 })).toThrow();
		expect(() =>
			validateImageDimensions({ width: 4096, height: 4097 }),
		).toThrow();
	});

	it("rejects paths outside project image assets", () => {
		expect(imageAssetPath("/project.cap", "content/images/a.png")).toBe(
			"/project.cap/content/images/a.png",
		);
		for (const path of [
			"/original/a.png",
			"../a.png",
			"content/images/../a.png",
			"content/images/sub/a.png",
		])
			expect(imageAssetPath("/project.cap", path)).toBeNull();
	});
});

describe("image geometry", () => {
	it("normalizes the oriented image to the output aspect without distortion", () => {
		const size = fitImageSize(400, 600, 1920, 1080);
		expect(size.y).toBeCloseTo(0.3);
		expect((size.x * 1920) / (size.y * 1080)).toBeCloseTo(400 / 600);
		const segment = defaultImageSegment(
			{ path: "content/images/a.png", name: "A", width: 400, height: 600 },
			1,
			4,
			2,
			{ width: 1920, height: 1080 },
		);
		expect(segment).toMatchObject({
			start: 1,
			end: 4,
			track: 2,
			center: { x: 0.5, y: 0.5 },
			opacity: 1,
			rotation: 0,
			lockAspect: true,
		});
	});

	it.each([0, 45, 90, -135])(
		"preserves aspect and the opposite corner at rotation %s",
		(rotation) => {
			const canvas = { width: 1000, height: 600 };
			const segment = {
				center: { x: 0.5, y: 0.5 },
				size: { x: 0.2, y: 0.2 },
				rotation,
				lockAspect: true,
			};
			const resized = resizeImage(
				segment,
				{ x: 30, y: 45 },
				{ x: 1, y: 1 },
				canvas,
			);
			expect(resized.size.x / resized.size.y).toBeCloseTo(1);
			const opposite = (image: typeof resized) => {
				const radians = (rotation * Math.PI) / 180;
				const x = (-image.size.x * canvas.width) / 2;
				const y = (-image.size.y * canvas.height) / 2;
				return {
					x:
						image.center.x * canvas.width +
						x * Math.cos(radians) -
						y * Math.sin(radians),
					y:
						image.center.y * canvas.height +
						x * Math.sin(radians) +
						y * Math.cos(radians),
				};
			};
			expect(opposite(resized).x).toBeCloseTo(opposite(segment).x);
			expect(opposite(resized).y).toBeCloseTo(opposite(segment).y);
		},
	);
});
